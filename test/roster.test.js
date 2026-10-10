// The client half of the roster delta: what a phone ends up holding when the server leaves a
// gallery out because that phone already has it (backend/transport.py roster_for).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// roster.js reaches state.js, which reaches env.js, which reads the query string and the camera
// elements at import time. mergeRoster touches none of that, so the browser globals it needs are
// stubbed rather than pulled in as a DOM.
globalThis.location ??= { search: '' };
globalThis.document ??= { getElementById: () => ({ getContext: () => ({}) }) };

const { mergeRoster } = await import('../frontend/public/roster.js');

const GALLERY_A = [{ hist: [1, 0], grid: [0, 1] }];
const GALLERY_B = [{ hist: [0, 1], grid: [1, 0] }];

test('an entry without a gallery keeps the one this phone already holds', () => {
  const held = [
    { id: 'a', name: 'Alice', gallery: GALLERY_A },
    { id: 'b', name: 'Bob', gallery: GALLERY_B },
  ];
  // Bob was rescanned; Alice's scan did not change, so the server left it out.
  const merged = mergeRoster(held, [
    { id: 'a', name: 'Alice' },
    { id: 'b', name: 'Bob', gallery: GALLERY_A },
  ]);
  assert.deepEqual(merged, [
    { id: 'a', name: 'Alice', gallery: GALLERY_A },
    { id: 'b', name: 'Bob', gallery: GALLERY_A },
  ]);
});

test('membership comes wholesale from the message, so leavers and joiners land correctly', () => {
  const held = [
    { id: 'a', name: 'Alice', gallery: GALLERY_A },
    { id: 'b', name: 'Bob', gallery: GALLERY_B },
  ];
  const merged = mergeRoster(held, [
    { id: 'a', name: 'Alice' },
    { id: 'c', name: 'Carol', gallery: GALLERY_B },
  ]);
  assert.deepEqual(
    merged.map((p) => p.id),
    ['a', 'c'],
    'Bob left, Carol arrived',
  );
  assert.deepEqual(merged[0].gallery, GALLERY_A, 'Alice keeps the scan we had');
});

test('a player we have never seen and whose gallery was withheld reads as simply unscanned', () => {
  // Can only happen for someone nobody has scanned yet: the server withholds a gallery only when
  // it has already put that exact one on this connection's wire.
  const merged = mergeRoster([], [{ id: 'a', name: 'Alice' }]);
  assert.deepEqual(merged, [{ id: 'a', name: 'Alice', gallery: [] }]);
});

test('an empty gallery that was sent on purpose is not mistaken for a withheld one', () => {
  // A player can be un-scanned on the server, and that empty gallery is sent explicitly. Reading
  // it as "keep what you have" would resurrect a scan the room no longer holds.
  const merged = mergeRoster([{ id: 'a', name: 'Alice', gallery: GALLERY_A }], [
    { id: 'a', name: 'Alice', gallery: [] },
  ]);
  assert.deepEqual(merged[0].gallery, []);
});

test('a full roster replaces everything, which is what a reconnect receives', () => {
  const stale = [{ id: 'a', name: 'Alice', gallery: GALLERY_A }];
  const merged = mergeRoster(stale, [
    { id: 'a', name: 'Alice', gallery: GALLERY_B },
    { id: 'b', name: 'Bob', gallery: GALLERY_B },
  ]);
  assert.deepEqual(merged[0].gallery, GALLERY_B);
  assert.deepEqual(merged[1].gallery, GALLERY_B);
});

test('merging does not mutate the roster it was given', () => {
  const held = [{ id: 'a', name: 'Alice', gallery: GALLERY_A }];
  mergeRoster(held, [{ id: 'a', name: 'Alice', gallery: GALLERY_B }]);
  assert.deepEqual(held, [{ id: 'a', name: 'Alice', gallery: GALLERY_A }]);
});
