// What the lobby shows and what Launch is allowed to do (frontend/public/screens/lobby.js).
//
// Two conditions gate Launch and they came from different lines of work, so the merge had to AND
// them rather than pick one: a round needs enough players, and `start` needs a live connection -
// without the second, a tap during a drop set an optimistic 3 s countdown and moved the player to
// a game screen while the message went nowhere.
//
// The row rendering is here because an audit found that gutting the row's className survives the
// whole of connection-lifecycle.test.js: `scanned` is what styles a player as ready, and nothing
// asserted it.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installBrowserStubs } from './helpers/dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);
const dom = installBrowserStubs();

const { renderLobby } = await import('../frontend/public/screens/lobby.js');
const { state } = await import('../frontend/public/state.js');

const player = (id, name, extra = {}) => ({ id, name, hp: 100, alive: true, ...extra });

beforeEach(() => {
  dom.reset();
  Object.assign(state, {
    myId: 'a',
    room: 'demo',
    connected: true,
    mode: 'lobby',
    roster: [
      { id: 'a', name: 'Ann', gallery: [1, 2, 3] },
      { id: 'b', name: 'Bo', gallery: [] },
    ],
    // The server keys rooms in lowercase and sends the code back that way, so the lobby is the
    // thing that has to put it in the case players read out to each other.
    game: { status: 'waiting', code: 'k7q2xz', maxHp: 100, minPlayers: 2, players: [player('a', 'Ann'), player('b', 'Bo')] },
  });
});

const rows = () => dom.$('lobby-list').children;

test('the room code is shown as players read it out', () => {
  renderLobby();
  assert.equal(dom.$('lobby-room').textContent, 'K7Q2XZ', "the server's lowercase code, upper-cased");

  // Before the first snapshot arrives there is only the code this phone dialled.
  state.game = null;
  state.room = 'demo12';
  renderLobby();
  assert.equal(dom.$('lobby-room').textContent, 'DEMO12');
});

test('a scanned player is marked as ready and an unscanned one is not', () => {
  renderLobby();
  assert.equal(rows()[0].className, 'lobby-player scanned', "Ann's scan has arrived");
  assert.equal(rows()[1].className, 'lobby-player', "Bo's has not");
  assert.match(rows()[0].children[0].children[1].textContent, /3 scan samples ready/);
  assert.equal(rows()[1].children[0].children[1].textContent, 'Not scanned');
});

test('Launch needs enough players', () => {
  renderLobby();
  assert.equal(dom.$('launch-btn').disabled, false, 'precondition: two players, connected');
  assert.equal(dom.$('lobby-waiting').hidden, true);

  state.game.players = [player('a', 'Ann')];
  renderLobby();
  assert.equal(dom.$('launch-btn').disabled, true, 'on your own there is nothing to start');
  assert.equal(dom.$('lobby-waiting').hidden, false, 'and the lobby says what it is waiting for');
});

test('Launch needs a live connection as well as enough players', () => {
  state.connected = false;
  renderLobby();
  assert.equal(dom.$('launch-btn').disabled, true, '`start` would go nowhere');

  state.connected = true;
  renderLobby();
  assert.equal(dom.$('launch-btn').disabled, false, 'and comes back with the connection');
});

test('Launch is disabled while a round is already running', () => {
  for (const status of ['countdown', 'playing']) {
    state.game.status = status;
    renderLobby();
    assert.equal(dom.$('launch-btn').disabled, true, status);
  }
});

test('a debug clone is listed as mirroring its owner and has no buttons of its own', () => {
  state.roster = [...state.roster, { id: 'a:debug-clone', name: 'Ann (clone)' }];
  state.game.players = [...state.game.players, player('a:debug-clone', 'Ann (clone)')];
  renderLobby();

  const clone = rows()[2];
  assert.match(clone.children[0].children[1].textContent, /Mirrors Ann's scan/);
  assert.equal(clone.children.length, 1, 'nothing to scan on a clone: it borrows the real scan');
});

test('a player is only scannable while no round is running', () => {
  renderLobby();
  const scanButton = () => rows()[1].children[1].children.at(-1);
  assert.equal(scanButton().textContent, 'Scan');
  assert.equal(scanButton().disabled, false);

  state.game.status = 'playing';
  renderLobby();
  assert.equal(scanButton().disabled, true, 'mid-round there is nobody to hand the phone to');
});

test('an already scanned player offers a rescan', () => {
  renderLobby();
  assert.equal(rows()[0].children[1].children.at(-1).textContent, 'Rescan');
});

test('the export and delete buttons stay off unless the page asked for them', () => {
  // Scan export is opt-in (?export in env.js). Without it the row has exactly one button, so a
  // regression that showed Import to every player in every lobby would land here.
  renderLobby();
  assert.equal(rows()[0].children[1].children.length, 1, 'Rescan and nothing else');
  assert.equal(rows()[1].children[1].children.length, 1, 'Scan and nothing else');
});
