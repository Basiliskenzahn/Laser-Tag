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
import { localSelfId, scannedGallery } from './roster.js';
import { identity } from './identity.js';
import { showJoinRejected } from './screens/join.js';
import { renderLobby, showLobby } from './screens/lobby.js';
import { enterGame, popup, renderHud, restartAnimation } from './screens/game.js';
import { showResults, updateResults } from './screens/results.js';

const UNREACHABLE_MESSAGE = "Can't connect to the game server. Check your internet connection. Still retrying…";
const LOBBY_RUNNING_MESSAGE = 'Lobby is already running.';

// Game control/state messages use HTTP polling. Health/death notifications use SSE once the
// player enters the game screen.
export function connect() {
  let opened = false;
  const conn = openPolling({
    onOpen() {
      opened = true;
      state.failedConnects = 0;
      showConnectionProblem(null);
      sendJoin();
    },
    onMessage: handleMessage,
    onClose() {
      if (state.conn !== conn) return;
      state.game = null;
      if (!opened) state.failedConnects++;
      showConnectionProblem(state.failedConnects >= 2 ? UNREACHABLE_MESSAGE : 'Connection lost. Reconnecting…');
      setTimeout(connect, 1500);
    },
  });
  state.conn = conn;
}

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
  renderHud();
}

export function send(msg) {
  state.conn?.send(msg);
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
      state.roster = msg.players;
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
  // Our own start (Launch, Rematch) is on its way: an "over" from before it must not end the new round.
  if (game.status === 'over' && state.launchingFromLobby) return;
  const me = game.players.find((player) => player.id === state.myId);
  if (state.mode === 'results') {
    // Only a new round takes us off the results screen; anything else just updates it.
    if (game.status !== 'countdown' && !(game.status === 'playing' && me?.alive)) {
      updateResults(game);
      return;
    }
    enterGame();
  }
  // The round is over for us: knocked out, or the last one standing.
  if (state.mode === 'game' && (game.status === 'over' || (game.status === 'playing' && me && !me.alive))) {
    showResults(game);
    return;
  }
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
  if ((game.status === 'countdown' || game.status === 'playing') && state.mode === 'lobby') {
    enterGame();
  }
  if (state.mode === 'lobby') renderLobby();
  renderHud();
}
