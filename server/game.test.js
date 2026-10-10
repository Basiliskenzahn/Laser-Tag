import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, MAX_HP, DAMAGE, COUNTDOWN_MS, SHOT_COOLDOWN_MS } from './game.js';

function makeRoom() {
  let t = 0;
  const clock = { advance: (ms) => (t += ms) };
  const room = new Room('test', { now: () => t });
  return { room, clock };
}

function startedRoom(names = ['a', 'b']) {
  const { room, clock } = makeRoom();
  for (const id of names) room.join(id, id, []);
  room.start();
  clock.advance(COUNTDOWN_MS);
  return { room, clock };
}

test('a round needs at least two players, and starts on request', () => {
  const { room } = makeRoom();
  room.join('a', 'Alice', []);
  assert.equal(room.start().ok, false);
  room.join('b', 'Bob', []);
  assert.equal(room.status, 'waiting');
  assert.equal(room.start().ok, true);
  assert.equal(room.status, 'countdown');
});

test('a room caps out, and rejects joins once a round is running', () => {
  const { room } = startedRoom();
  assert.equal(room.join('c', 'Carol', []).ok, false);
});

test('shots are ignored during the countdown', () => {
  const { room } = makeRoom();
  room.join('a', 'Alice', []);
  room.join('b', 'Bob', []);
  room.start();
  assert.equal(room.shoot('a', 'b', 'body').ok, false);
  assert.equal(room.players.get('b').hp, MAX_HP);
});

test('hits damage the target and respect the cooldown', () => {
  const { room, clock } = startedRoom();
  assert.equal(room.shoot('a', 'b', 'body').damage, DAMAGE.body);
  assert.equal(room.shoot('a', 'b', 'body').ok, false); // cooldown
  clock.advance(SHOT_COOLDOWN_MS);
  assert.equal(room.shoot('a', 'b', 'head').damage, DAMAGE.head);
  assert.equal(room.players.get('b').hp, MAX_HP - DAMAGE.body - DAMAGE.head);
});

test('a player cannot target themselves or someone outside the room', () => {
  const { room } = startedRoom();
  assert.equal(room.shoot('a', 'a', 'body').ok, false);
  assert.equal(room.shoot('a', 'ghost', 'body').ok, false);
});

test('knockout ends a two-player round and the winner can start the next one', () => {
  const { room, clock } = startedRoom();
  let result;
  do {
    result = room.shoot('a', 'b', 'head');
    clock.advance(SHOT_COOLDOWN_MS);
  } while (!result.ko);
  assert.equal(room.status, 'over');
  assert.equal(room.winner, 'a');
  assert.equal(room.players.get('a').wins, 1);
  assert.equal(room.shoot('a', 'b', 'body').ok, false);

  assert.equal(room.start().ok, true);
  assert.equal(room.status, 'countdown');
  assert.equal(room.players.get('b').hp, MAX_HP);
  assert.equal(room.players.get('b').alive, true);
});

test('free-for-all: the last player standing wins, eliminated players can no longer be hit', () => {
  const { room, clock } = startedRoom(['a', 'b', 'c']);
  let result;
  do {
    result = room.shoot('a', 'b', 'head');
    clock.advance(SHOT_COOLDOWN_MS);
  } while (!result.ko);
  assert.equal(room.players.get('b').alive, false);
  assert.equal(room.status, 'playing'); // c is still standing
  assert.equal(room.shoot('a', 'b', 'body').ok, false);

  do {
    result = room.shoot('a', 'c', 'head');
    clock.advance(SHOT_COOLDOWN_MS);
  } while (!result.ko);
  assert.equal(room.status, 'over');
  assert.equal(room.winner, 'a');
});

test('leaving a free-for-all removes that player without resetting the round', () => {
  const { room } = startedRoom(['a', 'b', 'c']);
  room.shoot('a', 'b', 'body');
  room.leave('b');
  assert.equal(room.status, 'playing');
  assert.equal(room.players.has('b'), false);
  assert.equal(room.players.get('a').hp, MAX_HP);
  assert.equal(room.players.get('c').hp, MAX_HP);
});

test('leaving can decide a free-for-all when only one player remains alive', () => {
  const { room, clock } = startedRoom(['a', 'b', 'c']);
  let result;
  do {
    result = room.shoot('a', 'b', 'head');
    clock.advance(SHOT_COOLDOWN_MS);
  } while (!result.ko);

  room.leave('c');
  assert.equal(room.status, 'over');
  assert.equal(room.winner, 'a');
  assert.equal(room.players.get('a').wins, 1);
});

test('roster carries each player\'s appearance gallery; state does not', () => {
  const { room } = makeRoom();
  room.join('a', 'Alice', [{ hist: [1, 0], grid: [0.5] }]);
  const roster = room.roster();
  assert.deepEqual(roster[0].gallery, [{ hist: [1, 0], grid: [0.5] }]);
  assert.equal('gallery' in room.snapshot().players[0], false);
});
