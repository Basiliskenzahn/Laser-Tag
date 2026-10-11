// The lobby's opt-in scan buttons (frontend/public/screens/lobby.js with ?export).
//
// `SCAN_EXPORT` is read once, from the query string, when env.js is imported - so "on" and "off"
// cannot both be exercised in one process. test/lobby-screen.test.js covers off, where the row has
// a Scan button and nothing else; this file covers on.
//
// Deleting someone else's scan is the one destructive thing any phone in the lobby can do to
// another player, so what is asserted here is that it asks first and that a refusal sends nothing.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installBrowserStubs } from './helpers/dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);
const dom = installBrowserStubs({ search: '?export' });

const { renderLobby } = await import('../frontend/public/screens/lobby.js');
const { state } = await import('../frontend/public/state.js');

const player = (id, name) => ({ id, name, hp: 100, alive: true });

let sent;
let confirmed;

beforeEach(() => {
  dom.reset();
  sent = [];
  confirmed = true;
  globalThis.confirm = () => confirmed;
  globalThis.fetch = (path, options) => {
    sent.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    return Promise.resolve({ ok: true, redirected: false, json: () => Promise.resolve([]) });
  };
  Object.assign(state, {
    myId: 'a',
    room: 'demo',
    connected: true,
    mode: 'lobby',
    conn: { send: (msg) => (sent.push({ path: 'conn', body: msg }), Promise.resolve(true)), close() {} },
    roster: [
      { id: 'a', name: 'Ann', gallery: [1, 2, 3] },
      { id: 'b', name: 'Bo', gallery: [] },
    ],
    game: { status: 'waiting', code: 'DEMO12', maxHp: 100, minPlayers: 2, players: [player('a', 'Ann'), player('b', 'Bo')] },
  });
  renderLobby();
});

const rows = () => dom.$('lobby-list').children;
const buttons = (row) => rows()[row].children[1].children.map((button) => button.textContent);
const click = (button) => button.listeners.get('click').forEach((fn) => fn({}));
const messages = () => sent.filter((entry) => entry.path === 'conn').map((entry) => entry.body);

test('an unscanned player can be imported into, and a scanned one exported and cleared', () => {
  assert.deepEqual(buttons(1), ['Import', 'Scan'], 'nothing to export or delete yet');
  assert.deepEqual(buttons(0), ['Import', 'Export', 'Rescan', '✕']);
});

test('deleting a scan asks first and tells the server who it was', () => {
  const deleteButton = rows()[0].children[1].children.at(-1);
  assert.equal(deleteButton.getAttribute('aria-label'), "Delete Ann's scan");

  click(deleteButton);
  assert.deepEqual(messages(), [{ type: 'clearScan', targetId: 'a' }]);
});

test('saying no to the confirmation deletes nothing', () => {
  confirmed = false;
  click(rows()[0].children[1].children.at(-1));
  assert.deepEqual(messages(), [], 'the scan is still there');
});

test('nothing is imported, deleted or rescanned while a round is running', () => {
  state.game.status = 'playing';
  renderLobby();
  const disabled = rows()[0].children[1].children.map((button) => button.disabled);
  assert.deepEqual(disabled, [true, false, true, true], 'Export is the only harmless one mid-round');
});
