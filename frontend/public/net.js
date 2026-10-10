// The conversation with the game server, and what each thing it says does to the screens.
//
// Control and state messages travel over HTTP long-polling (transport.js), which keeps working
// through proxies and self-signed local HTTPS; health and death notifications arrive over SSE
// once the game screen is open. A lost connection retries forever and says so on whichever
// screen is showing, and the server's welcome is what later lets a reloaded page resume as the
// same player.

import { openPolling } from './transport.js';
import * as sound from './sound.js';
import { DEBUG, $ } from './env.js';
import { state, saveActiveLobby } from './state.js';
import { localSelfId, mergeRoster, scannedGallery } from './roster.js';
import { identity } from './identity.js';
import { showJoinRejected } from './screens/join.js';
import { renderLobby, showLobby } from './screens/lobby.js';
import { cancelScan } from './screens/scan.js';
import { enterGame, popup, renderHud, restartAnimation } from './screens/game.js';

const UNREACHABLE_MESSAGE = "Can't connect to the game server. Check your internet connection. Still retrying…";
const LOBBY_RUNNING_MESSAGE = 'Lobby is already running.';
const RECONNECT_DELAY_MS = 1_500;

// The pending reconnect, so that leaving a room can call it off.
//
// Without a handle on it, a connection that dropped within RECONNECT_DELAY_MS of the player
// tapping Leave would quietly rejoin the room they had just left: leaveLobby() deliberately keeps
// name/room/resumePlayerId so that a blip reconnects as the same player, so the retry's sendJoin()
// had everything it needed. The result was a player in everyone else's roster who cannot be
// scanned or shot while their phone sits on the join screen - and because the `welcome` saves the
// active lobby, the next page load resumed straight back into that room.
let reconnectTimer = null;

function cancelReconnect() {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

// Leaving a room for good, as opposed to riding out a blip: call off any pending retry first so
// nothing dials back in behind the player, drop the connection, and stop the per-room identity
// signals (the motion provider's sensor and the activity it has collected per player id).
export function leaveRoom({ notify = false } = {}) {
  cancelReconnect();
  state.conn?.close({ notify });
  state.conn = null;
  state.connected = false;
  identity.stop();
}

// Game control/state messages use HTTP polling. Health/death notifications use SSE once the
// player enters the game screen.
export function connect() {
  cancelReconnect(); // there is only ever one attempt in flight
  let opened = false;
  const conn = openPolling({
    onOpen() {
      opened = true;
      state.connected = true;
      state.failedConnects = 0;
      showConnectionProblem(null);
      sendJoin();
    },
    onMessage: handleMessage,
    onClose() {
      if (state.conn !== conn) return;
      // The last snapshot is kept, not cleared. Everything that gates on `state.game` - the HUD,
      // whether this phone may fire, what is under the crosshair - would otherwise blank out for
      // the whole retry window on every blip, which on a phone network is often. A snapshot a
      // second or two old is a far better description of the round than no snapshot at all, and
      // `state.connected` is what callers use to know it is no longer live: Launch reads it (see
      // renderLobby), and the banner below says so on screen either way.
      state.connected = false;
      if (!opened) state.failedConnects++;
      showConnectionProblem(state.failedConnects >= 2 ? UNREACHABLE_MESSAGE : 'Connection lost. Reconnecting…');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        // Belt and braces behind cancelReconnect(): every "we are leaving" path nulls state.conn,
        // so a retry that outlives one has nothing to reconnect for.
        if (state.conn !== conn) return;
        connect();
      }, RECONNECT_DELAY_MS);
    },
  });
  state.conn = conn;
}

// Closing the tab, or navigating away from the page, should drop this player out of the room at
// once rather than leaving a phantom in the roster until the server times the long poll out. This
// lives here rather than in app.js's wiring because the beacon that does it belongs to the
// connection, and app.js has no handle on one.
//
// `pagehide` and not `beforeunload`: iOS Safari does not reliably fire beforeunload. Deliberately
// not `visibilitychange` either - the page goes hidden every time the player glances at a
// notification or answers a message, and a round has to survive that.
export function notifyLeaving() {
  leaveRoom({ notify: true });
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', notifyLeaving);

function sendJoin() {
  if (state.name && state.room) {
    send({
      type: 'join',
      name: state.name,
      room: state.room,
      playerId: state.resumePlayerId,
      gallery: state.localGallery,
      debug: DEBUG,
    });
  }
}

// Connection problems go on whichever screen is showing: the scan panel or the game banner.
export function showConnectionProblem(text) {
  $('scan-connection').textContent = text ?? '';
  $('scan-connection').hidden = !text || state.mode !== 'scan';
  $('lobby-connection').textContent = text ?? '';
  $('lobby-connection').hidden = !text || state.mode !== 'lobby';
  state.bannerOverride = text;
  // renderLobby is the only writer of the Launch button's disabled state, so a connection coming
  // or going has to re-render the lobby as well as the HUD. Without this, Launch stayed enabled
  // through a drop: tapping it set an optimistic 3 s countdown and moved the player to the game
  // screen - which has no leave control - while the `start` went nowhere.
  if (state.mode === 'lobby') renderLobby();
  renderHud();
}

// Resolves true once the server has the message, false if it could not be delivered - including
// when there is no connection at all. A caller that has told the player something worked must
// wait for it (saving a scan); fire-and-forget callers can ignore it, and ignoring it is safe
// because it never rejects.
export function send(msg) {
  return state.conn?.send(msg) ?? Promise.resolve(false);
}

export function openGameEvents() {
  state.events?.close();
  const room = encodeURIComponent(state.room);
  const events = new EventSource(`/events/${room}`);
  events.onmessage = handleGameEvent;
  events.addEventListener('health', (event) => handleGameEvent(event));
  events.addEventListener('death', (event) => handleGameEvent(event));
  events.onerror = () => {
    // EventSource reconnects automatically; no UI noise needed during play.
  };
  state.events = events;
}

function handleGameEvent(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (DEBUG && (msg.type === 'health' || msg.type === 'death')) {
    console.debug('game event', msg);
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      state.myId = msg.id;
      state.resumePlayerId = msg.id;
      state.bannerOverride = null;
      saveActiveLobby();
      break;
    case 'error':
      if (!state.myId && [LOBBY_RUNNING_MESSAGE, 'Round already running'].includes(msg.message)) {
        showJoinRejected(LOBBY_RUNNING_MESSAGE);
        return;
      }
      if (state.launchingFromLobby) {
        state.launchingFromLobby = false;
        showLobby(msg.message);
        return;
      }
      state.bannerOverride = msg.message;
      if (state.mode === 'lobby') $('lobby-status').textContent = msg.message;
      renderHud();
      break;
    case 'roster':
      // A delta: entries without a `gallery` keep the one we already hold (see mergeRoster).
      state.roster = mergeRoster(state.roster, msg.players);
      state.localGallery = scannedGallery(localSelfId());
      if (state.mode === 'lobby') renderLobby();
      break;
    case 'scanSaved':
      if (state.mode === 'lobby') $('lobby-status').textContent = 'Scan saved.';
      break;
    case 'state':
      onState(msg.state);
      break;
    case 'hitConfirmed':
      sound.hitConfirmed(msg.zone === 'head');
      restartAnimation($('crosshair'), 'hit');
      popup(msg.zone === 'head' ? `HEADSHOT −${msg.damage}` : `−${msg.damage}`, msg.zone === 'head');
      break;
    case 'gotHit':
      sound.hurt();
      navigator.vibrate?.(msg.zone === 'head' ? [80, 40, 160] : 120);
      restartAnimation($('damage'), 'flash');
      break;
    default:
      // Nothing on screen wants it, so it is a signal for whatever is identifying people
      // (identity.js); messages nobody claims are ignored there.
      identity.onServerMessage(msg);
  }
}

function onState(game) {
  const previous = state.game;
  state.game = game;
  // Keep the countdown running into "playing" so "GO!" stays up briefly; updateCountdown clears it.
  if (game.status === 'countdown') state.countdownEndsAt = performance.now() + game.startsInMs;
  else if (game.status !== 'playing') state.countdownEndsAt = null;
  if (game.status === 'countdown' || game.status === 'playing') state.launchingFromLobby = false;
  if (game.status === 'over') {
    const winner = game.players.find((player) => player.id === game.winner);
    const message = game.winner === state.myId ? 'You win!' : `${winner?.name ?? 'Someone'} wins!`;
    if (previous?.status !== 'over') {
      game.winner === state.myId ? sound.win() : sound.lose();
    }
    if (state.mode !== 'lobby') showLobby(message);
    else {
      $('lobby-status').textContent ||= message;
      renderLobby();
    }
    return;
  }
  if (game.status === 'countdown' || game.status === 'playing') {
    // A scan in progress is over the moment the round starts, and this phone has to go with it.
    // It used to enter the game only from the lobby, so a round starting mid-scan left the phone
    // in 'scan': both the `countdown` snapshot and the `playing` one behind it were recorded and
    // dropped, and when the scan finished it dropped the player back into a lobby with Launch and
    // every Scan button disabled and nothing on screen to say a round was running. The backend
    // pushes a snapshot once per transition and then only on events, so it self-healed only when
    // somebody landed a hit. Cancelling retires the scan's run token, which is what stops a scan
    // still parked on an await from finishing later and yanking the player out of the round.
    if (state.mode === 'scan') cancelScan();
    if (state.mode === 'lobby') enterGame();
  }
  if (state.mode === 'lobby') renderLobby();
  renderHud();
}
