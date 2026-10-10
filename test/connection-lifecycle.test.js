// What happens to this phone when the connection comes and goes (frontend/public/net.js).
//
// These drive the real net.js against a fake server (helpers/fake-server.js), because every bug
// here lived in the join between the transport, the retry timer and the screens - not in any one
// of them. net.js reaches screens/game.js -> detector.js, which imports an absolute /vendor/ URL
// Node cannot resolve, so helpers/vendor-hooks.js maps that one specifier to a stub.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createFakeServer, flush } from './helpers/fake-server.js';
import { installBrowserStubs } from './helpers/dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);
const dom = installBrowserStubs();

const net = await import('../frontend/public/net.js');
const { state } = await import('../frontend/public/state.js');
const { leaveLobby } = await import('../frontend/public/screens/lobby.js');

mock.timers.enable({ apis: ['setTimeout'] });

// Long enough for the rejected poll to walk back out through the transport's awaits into onClose.
async function settleClose() {
  for (let i = 0; i < 20; i++) await flush();
}

const snapshot = (status, extra = {}) => ({
  status,
  code: 'demo',
  maxHp: 100,
  minPlayers: 2,
  players: [
    { id: 'p1', name: 'Ann', hp: 100, alive: true },
    { id: 'p2', name: 'Bo', hp: 100, alive: true },
  ],
  ...extra,
});

let server;

beforeEach(() => {
  net.leaveRoom(); // cancel any retry a previous test left pending
  dom.reset();
  server = createFakeServer();
  globalThis.fetch = server.fetch;
  Object.assign(state, {
    name: 'Ann',
    room: 'demo',
    resumePlayerId: 'p1',
    myId: null,
    game: null,
    roster: [],
    mode: 'lobby',
    failedConnects: 0,
    bannerOverride: null,
    countdownEndsAt: null,
    connected: false,
    startingLobby: false,
  });
});

// Opens a connection and waits until the join has gone out and the client is polling.
async function connected() {
  net.connect();
  await server.settle();
  assert.deepEqual(
    server.sends.map((msg) => msg.type),
    ['join'],
    'precondition: the connection opened and joined the room',
  );
  return server;
}

const joins = () => server.sends.filter((msg) => msg.type === 'join').length;

test('leaving the lobby inside the reconnect window does not rejoin the room', async () => {
  // The ghost player: the connection drops, the player taps Leave within the retry delay, and the
  // retry rejoins - leaveLobby keeps name/room/resumePlayerId on purpose, so sendJoin has
  // everything it needs. Nobody could scan or shoot that player, and the `welcome` saved the room
  // as the one to resume into on the next page load.
  await connected();
  server.drop();
  await settleClose();
  assert.equal(dom.$('lobby-connection').textContent, 'Connection lost. Reconnecting…');

  leaveLobby();
  assert.equal(state.conn, null);
  assert.equal(server.disconnects.length, 1, 'the server was told we left');

  mock.timers.tick(60_000); // far past any retry delay
  await settleClose();

  assert.equal(server.connects, 1, 'nothing dialled back in');
  assert.equal(joins(), 1, 'and so nothing rejoined the room');
  assert.equal(state.mode, 'join', 'the phone is on the join screen, as the player left it');
});

test('leaving cancels the pending retry rather than leaning on the guard behind it', async () => {
  // Two things stop a stale retry: leaveRoom cancels the timer, and the timer re-checks
  // state.conn before reconnecting. Either alone is enough to keep the test above green, which is
  // the point of having both - but it also means a regression that dropped the cancellation would
  // go unnoticed there, leaving a timer to fire on every leave. So pin it directly.
  await connected();
  server.drop();
  await settleClose();

  const cleared = [];
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (handle) => {
    cleared.push(handle);
    return realClearTimeout(handle);
  };
  try {
    leaveLobby();
    assert.equal(cleared.length, 1, 'the pending reconnect was cleared, not just ignored later');
  } finally {
    globalThis.clearTimeout = realClearTimeout;
  }
});

test('a join the room rejected is not undone by a retry that was already pending', async () => {
  const { showJoinRejected } = await import('../frontend/public/screens/join.js');
  await connected();
  server.drop();
  await settleClose();

  showJoinRejected('Lobby is already running.');
  mock.timers.tick(60_000);
  await settleClose();

  assert.equal(server.connects, 1);
  assert.equal(joins(), 1);
  assert.equal(dom.$('join-status').textContent, 'Lobby is already running.');
});

test('an ordinary blip still reconnects and rejoins', async () => {
  // The cancellable timer must not have cost us the reconnect it exists for.
  await connected();
  server.drop();
  await settleClose();

  mock.timers.tick(60_000);
  await server.settle();

  assert.equal(server.connects, 2, 'dialled back in');
  assert.equal(joins(), 2, 'and rejoined as the same player');
  assert.equal(server.sends.at(-1).playerId, 'p1');
  assert.equal(state.connected, true);
  assert.equal(dom.$('lobby-connection').textContent, '', 'the banner cleared');
});

test('only one reconnect is ever in flight', async () => {
  await connected();
  server.drop();
  await settleClose();
  net.connect(); // e.g. a fresh join while a retry was pending
  await server.settle();
  mock.timers.tick(60_000);
  await settleClose();

  assert.equal(server.connects, 2, 'the explicit connect, and no retry behind it');
});

test('Launch is disabled while the connection is down', async () => {
  // renderLobby is the only writer of the button's disabled state, so a drop that did not
  // re-render the lobby left it enabled: tapping it set an optimistic 3 s countdown and moved the
  // player to a game screen with no leave control, while `start` went nowhere.
  await connected();
  server.push({ type: 'state', state: snapshot('waiting') });
  await server.settle();
  assert.equal(dom.$('launch-btn').disabled, false, 'precondition: a startable round, connected');

  server.drop();
  await settleClose();
  assert.equal(dom.$('launch-btn').disabled, true);

  mock.timers.tick(60_000);
  await server.settle();
  assert.equal(dom.$('launch-btn').disabled, false, 'and enabled again once the connection is back');
});

test('a countdown that arrives during a scan still takes the phone into the round', async () => {
  // The stranded phone: onState only entered the game from 'lobby', so a round starting mid-scan
  // recorded the countdown snapshot and the playing one behind it and did nothing with either.
  // The backend pushes a snapshot once per transition and then only on events, so the phone sat
  // in a lobby with Launch and every Scan button disabled until somebody landed a hit.
  await connected();
  state.mode = 'scan';
  dom.$('scan-screen').hidden = false;

  server.push({ type: 'state', state: snapshot('countdown', { startsInMs: 3000 }) });
  await server.settle();

  assert.equal(state.mode, 'game');
  assert.equal(dom.$('game-screen').hidden, false);
  assert.equal(dom.$('scan-screen').hidden, true);
  assert.deepEqual(globalThis.EventSource.opened, ['/events/demo'], 'and the game events are open');
});

test('a playing snapshot that arrives during a scan still takes the phone into the round', async () => {
  // The follow-up snapshot was dropped for the same reason, which is what made it unrecoverable.
  await connected();
  state.mode = 'scan';
  server.push({ type: 'state', state: snapshot('playing') });
  await server.settle();
  assert.equal(state.mode, 'game');
});

test('a blip keeps the last snapshot instead of blanking the round', async () => {
  // state.game = null on every transient close emptied the HUD and blocked firing for the whole
  // retry window, which on a phone network is often. `connected` is what says it is no longer
  // live; the snapshot itself is at most a second or two stale.
  await connected();
  state.mode = 'game';
  server.push({ type: 'state', state: snapshot('playing') });
  await server.settle();

  server.drop();
  await settleClose();

  assert.equal(state.connected, false);
  assert.equal(state.game?.status, 'playing');
  assert.equal(state.game.players.length, 2);
});

test('leaving for good does clear the round', async () => {
  await connected();
  server.push({ type: 'state', state: snapshot('playing') });
  await server.settle();
  leaveLobby();
  assert.equal(state.game, null);
  assert.equal(state.connected, false);
});

test('a send that cannot be delivered resolves false for the caller', async () => {
  // What saveCurrentScan needs in order to stop telling the player "Saved scan for X." about a
  // ~190 KB gallery that never left the phone.
  await connected();
  server.sendFailures = 50;

  let result;
  net.send({ type: 'scan', targetId: 'p2', gallery: [1, 2, 3] }).then((value) => {
    result = value;
  });
  for (let i = 0; i < 20 && result === undefined; i++) {
    mock.timers.tick(60_000);
    await flush();
  }

  assert.equal(result, false);
  assert.deepEqual(
    server.sends.map((msg) => msg.type),
    ['join'],
    'the scan never reached the server',
  );
  assert.equal(state.connected, true, 'and the failed send did not take the connection with it');
  assert.equal(server.connects, 1);
});

test('a send with no connection at all resolves false rather than undefined', async () => {
  state.conn = null;
  assert.equal(await net.send({ type: 'scan' }), false);
});

test('a delivered send resolves true', async () => {
  await connected();
  assert.equal(await net.send({ type: 'start' }), true);
});

test('closing the tab tells the server once, and leaves no retry behind', async () => {
  // There was no pagehide/beforeunload/visibilitychange handler anywhere in the codebase, so a
  // closed tab left the player in the room until the server timed the long poll out - the same
  // phantom as leaving inside the reconnect window.
  assert.ok(dom.windowListeners.has('pagehide'), 'net.js wires the goodbye to pagehide');
  await connected();

  dom.fireWindow('pagehide');
  dom.fireWindow('pagehide', { persisted: true });
  await flush();

  assert.equal(server.disconnects.length, 1, 'told exactly once');
  assert.equal(state.conn, null);
  assert.equal(state.connected, false);

  mock.timers.tick(60_000);
  await settleClose();
  assert.equal(server.connects, 1, 'and nothing dialled back in from the closed page');
});

test('a throw while starting the lobby does not latch the join button', async () => {
  // `startingLobby` gates the join button for the whole camera/model wait, so a throw inside that
  // window used to leave the button permanently inert with nothing on screen to say why. Nothing
  // in there is known to throw - the camera step has its own catch - so this is the hardening the
  // audit asked for rather than a reproduction of a real crash; the throw is injected.
  const { enterLobbyFromForm } = await import('../frontend/public/screens/join.js');
  dom.$('name').value = 'Ann';
  dom.$('room').value = 'demo';

  const btn = dom.$('join-btn');
  let thrown = false;
  const descriptor = Object.getOwnPropertyDescriptor(btn, 'hidden');
  Object.defineProperty(btn, 'hidden', {
    configurable: true,
    get() {
      return this.hiddenValue;
    },
    set(value) {
      // Once, at the first write after state.startingLobby = true.
      if (!thrown) {
        thrown = true;
        throw new Error('injected: something in the join path threw');
      }
      this.hiddenValue = value;
    },
  });
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await enterLobbyFromForm(); // must not reject: app.js's three callers have no .catch
    assert.ok(thrown, 'precondition: the injected throw happened inside the guarded window');
    assert.equal(state.startingLobby, false, 'the flag that gates the join button was released');
    assert.equal(btn.disabled, false, 'and the button is usable again');
    assert.match(dom.$('join-status').textContent, /Try again/, 'with something on screen to say so');
    assert.equal(errors.length, 1, 'the throw was logged rather than hidden');
  } finally {
    console.error = realError;
    Object.defineProperty(btn, 'hidden', descriptor ?? { value: false, writable: true, configurable: true });
  }
});

test('leaving a room stops the installed identity provider', () => {
  // The seam has to stay symmetric: with ?motion=off the appearance provider is installed, and
  // leaveRoom calls stop() on whichever one it is.
  assert.equal(typeof net.leaveRoom, 'function');
  net.leaveRoom(); // would throw if the installed provider had no stop()
});

test('a connection that never opens counts up to the unreachable message', async () => {
  // The counter still has to work: it is what tells "Reconnecting…" apart from "check your
  // internet connection", and a handler throw must never be able to reach it (see
  // transport-lifecycle.test.js).
  server.connectFailures = 5;
  net.connect();
  await settleClose();
  assert.equal(state.failedConnects, 1);
  assert.equal(dom.$('lobby-connection').textContent, 'Connection lost. Reconnecting…');

  mock.timers.tick(60_000);
  await settleClose();
  assert.equal(state.failedConnects, 2);
  assert.match(dom.$('lobby-connection').textContent, /Check your internet connection/);
  net.leaveRoom();
});
