import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, MAX_HP, DAMAGE, COUNTDOWN_MS, SHOT_COOLDOWN_MS } from './game.js';

function makeRoom() {
  let t = 0;
  const clock = { advance: (ms) => (t += ms) };
  const room = new Room('test', { now: () => t });
  return { room, clock };
}

function startedRoom() {
  const { room, clock } = makeRoom();
  room.join('a', 'Alice');
  room.join('b', 'Bob');
  clock.advance(COUNTDOWN_MS);
  return { room, clock };
}

test('second player starts the countdown, third is rejected', () => {
  const { room } = makeRoom();
  room.join('a', 'Alice');
  assert.equal(room.status, 'waiting');
  room.join('b', 'Bob');
  assert.equal(room.status, 'countdown');
  assert.equal(room.join('c', 'Carol').ok, false);
});

test('shots are ignored during the countdown', () => {
  const { room } = makeRoom();
  room.join('a', 'Alice');
  room.join('b', 'Bob');
  assert.equal(room.shoot('a', 'body').ok, false);
  assert.equal(room.opponentOf('a').hp, MAX_HP);
});

test('hits damage the opponent and respect the cooldown', () => {
  const { room, clock } = startedRoom();
  assert.equal(room.shoot('a', 'body').damage, DAMAGE.body);
  assert.equal(room.shoot('a', 'body').ok, false);
  clock.advance(SHOT_COOLDOWN_MS);
  assert.equal(room.shoot('a', 'head').damage, DAMAGE.head);
  assert.equal(room.players.get('b').hp, MAX_HP - DAMAGE.body - DAMAGE.head);
});

test('knockout ends the round and rematch resets health', () => {
  const { room, clock } = startedRoom();
  let result;
  do {
    result = room.shoot('a', 'head');
    clock.advance(SHOT_COOLDOWN_MS);
  } while (!result.ko);
  assert.equal(room.status, 'over');
  assert.equal(room.winner, 'a');
  assert.equal(room.players.get('a').wins, 1);
  assert.equal(room.shoot('a', 'body').ok, false);

  room.rematch();
  assert.equal(room.status, 'countdown');
  assert.equal(room.players.get('b').hp, MAX_HP);
});

test('leaving resets the round for the remaining player', () => {
  const { room } = startedRoom();
  room.shoot('a', 'body');
  room.leave('b');
  assert.equal(room.status, 'waiting');
  assert.equal(room.players.get('a').hp, MAX_HP);
});
