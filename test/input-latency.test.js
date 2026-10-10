// The ?debug input readout (frontend/public/input-latency.js).
//
// The readout exists to separate two delays the player cannot tell apart - the tap waiting for
// the main thread, and fire() doing work before it sends the shot - so the tests that matter are
// the ones that would fail if the line stopped distinguishing those, and the ones that hold down
// the guards on `event.timeStamp`. A wrong delivery-wait number is worse than none: it is the
// number the whole investigation is sized against.
//
// Expected values are LITERALS throughout, never derived from the constants the code uses. A test
// that computes its expectation from the same constant as the code is `x >= x`; the constants get
// their own tripwire at the bottom instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_WINDOW_MS,
  MAX_PLAUSIBLE_BLOCK_MS,
  MAX_PLAUSIBLE_WAIT_MS,
  SHOT_SAMPLES,
  deliveryWait,
  emptyInputStats,
  inputLatencyLine,
  longestBlock,
  recordBlock,
  recordShot,
} from '../frontend/public/input-latency.js';

// ---- the distinction the whole line exists for ----

test('a tap that queued behind an inference reads differently from a slow fire()', () => {
  // The reported bug: the tap sat for 104 ms, and fire() itself was instant once it ran.
  const queued = emptyInputStats();
  recordShot(queued, { eventTimeStamp: 1000, entryAt: 1104, resolvedAt: 1105 });

  // The other bug: the tap was delivered immediately and fire() spent 70 ms before sending.
  const slowShot = emptyInputStats();
  recordShot(slowShot, { eventTimeStamp: 1000, entryAt: 1002, resolvedAt: 1072 });

  assert.equal(inputLatencyLine(queued), 'Input tap 104/104 shot 1/1 n1');
  assert.equal(inputLatencyLine(slowShot), 'Input tap 2/2 shot 70/70 n1');
  assert.notEqual(inputLatencyLine(queued), inputLatencyLine(slowShot));
});

test('the worst tap is shown next to the mean, so one bad shot cannot hide', () => {
  const stats = emptyInputStats();
  // Three snappy shots and one that waited behind a pose inference. A mean alone would read 32 ms
  // and nobody would go looking; the 118 is what the player complained about.
  for (const wait of [4, 3, 3]) recordShot(stats, { eventTimeStamp: 1000, entryAt: 1000 + wait, resolvedAt: 1000 + wait });
  recordShot(stats, { eventTimeStamp: 2000, entryAt: 2118, resolvedAt: 2118 });

  assert.equal(inputLatencyLine(stats), 'Input tap 32/118 shot 0/0 n4');
});

test('the longest blocking chunk is reported, not the average frame', () => {
  const stats = emptyInputStats();
  stats.blockWindowStart = 1000;
  for (const gap of [16, 17, 16, 96, 16, 17]) recordBlock(stats, gap, 1000);

  assert.equal(longestBlock(stats), 96);
  assert.equal(inputLatencyLine(stats), 'Input block 96');
});

// ---- the event.timeStamp reasoning, held down ----

test('the delivery wait is measured from when the browser made the event, not when we looked', () => {
  // A pointerdown created at 1000 whose listener ran at 1142: 142 ms of queueing, which is the
  // whole quantity under investigation. Reading the clock twice inside the handler would give 0.
  assert.equal(deliveryWait(1000, 1142), 142);
});

test('a timestamp from another time origin is refused rather than printed', () => {
  // Legacy and cross-document events can carry a Unix epoch millisecond stamp. Against a page
  // that has been open for two seconds that subtracts to about -1.7e12, which as a "delivery
  // wait" would be nonsense in the one direction nobody checks.
  assert.equal(deliveryWait(1_760_000_000_000, 2000), null);
  // And the reverse: a stamp implausibly far in the future.
  assert.equal(deliveryWait(2000, 2000 + MAX_PLAUSIBLE_WAIT_MS + 1000), null);
});

test('a stamp of exactly zero is refused, not read as the age of the page', () => {
  // Some synthesized events carry 0, which is the page's time origin. Taken literally, a tap
  // three seconds into a round would report 3000 ms of input lag - and three seconds is the
  // important case, because it is under the implausible-wait ceiling and so gets past every other
  // guard. A tap in minute three would be caught by that ceiling anyway; this one would not.
  assert.equal(deliveryWait(0, 3000), null);
  assert.equal(deliveryWait(0, 180_000), null);
});

test('clock coarsening cannot make a wait negative', () => {
  // Timestamps are coarsened for privacy and a listener can run in the same tick the event was
  // created in, so a hair of negative is zero, not a bad sample.
  assert.equal(deliveryWait(1000.4, 1000), 0);
  assert.equal(deliveryWait(1002, 1000), 0);
  // Beyond the tolerance it is not coarsening, it is a different clock.
  assert.equal(deliveryWait(1050, 1000), null);
});

test('a missing or unusable timestamp leaves the tap figure blank but keeps the shot figure', () => {
  // The keyboard path and any caller without an event pass nothing. That must not cost us the
  // half of the measurement that does not need a timestamp.
  const stats = emptyInputStats();
  recordShot(stats, { eventTimeStamp: null, entryAt: 1000, resolvedAt: 1041 });

  assert.equal(inputLatencyLine(stats), 'Input tap -/- shot 41/41 n1');
});

// ---- the guards that stop the line lying ----

test('a hidden tab is not reported as the main thread blocking for a minute', () => {
  // requestAnimationFrame stops entirely when the tab is hidden, so the first frame back shows a
  // gap of however long the phone was in a pocket. Counting that would make `block` useless for
  // the rest of the session.
  const stats = emptyInputStats();
  stats.blockWindowStart = 1000;
  recordBlock(stats, 40_000, 1000);
  recordBlock(stats, 83, 1000);

  assert.equal(longestBlock(stats), 83);
});

test('a blocking chunk ages out, so the line says "now" rather than "ever"', () => {
  const stats = emptyInputStats();
  stats.blockWindowStart = 1000;
  recordBlock(stats, 240, 1000);
  assert.equal(longestBlock(stats), 240);

  // One window on: still visible, because it is the previous half-window.
  recordBlock(stats, 16, 1000 + BLOCK_WINDOW_MS + 1);
  assert.equal(longestBlock(stats), 240);

  // Two windows past the one it was recorded in: gone, and the current reading stands alone.
  recordBlock(stats, 20, 1000 + BLOCK_WINDOW_MS * 3 + 2);
  assert.equal(longestBlock(stats), 20);
});

test('a long gap with nothing since does not resurface as the current reading', () => {
  // The stale-previous case: if a roll-over copied `current` forward unconditionally, a 300 ms
  // chunk from ten seconds ago would reappear every time the window rolled.
  const stats = emptyInputStats();
  stats.blockWindowStart = 1000;
  recordBlock(stats, 300, 1000);
  recordBlock(stats, 16, 1000 + BLOCK_WINDOW_MS * 10);

  assert.equal(longestBlock(stats), 16);
});

test('only the most recent shots are kept, so walking to a new spot changes the reading', () => {
  const stats = emptyInputStats();
  // One terrible shot, then a long run of good ones. The bad one must fall off the end.
  recordShot(stats, { eventTimeStamp: 1000, entryAt: 1400, resolvedAt: 1400 });
  for (let i = 0; i < 12; i++) recordShot(stats, { eventTimeStamp: 2000 + i, entryAt: 2005 + i, resolvedAt: 2005 + i });

  assert.equal(stats.shots.length, 8);
  assert.equal(inputLatencyLine(stats), 'Input tap 5/5 shot 0/0 n8');
});

test('nothing measured yet says nothing, rather than a row of dashes', () => {
  // A line of placeholders reads exactly like a measurement of zero, which is the one reading
  // that would stop someone investigating.
  assert.equal(inputLatencyLine(emptyInputStats()), '');
  assert.equal(inputLatencyLine(null), '');
});

test('the shot and the block figures appear together when both are known', () => {
  const stats = emptyInputStats();
  stats.blockWindowStart = 1000;
  recordBlock(stats, 96, 1000);
  recordShot(stats, { eventTimeStamp: 1000, entryAt: 1088, resolvedAt: 1090 });

  assert.equal(inputLatencyLine(stats), 'Input tap 88/88 shot 2/2 n1 · block 96');
});

// ---- costs nothing when ?debug is absent ----

test('every recorder is a no-op on the null stats a non-debug load holds', () => {
  // screens/game.js keeps `inputStats` as null without ?debug, so even a call that escaped its
  // if (DEBUG) branch must not throw or allocate.
  assert.equal(recordShot(null, { eventTimeStamp: 1000, entryAt: 1100, resolvedAt: 1100 }), null);
  assert.equal(recordBlock(null, 96, 1000), null);
  assert.equal(longestBlock(null), 0);
  assert.equal(inputLatencyLine(null), '');
});

test('a garbage sample is dropped instead of poisoning the window', () => {
  const stats = emptyInputStats();
  stats.blockWindowStart = 1000;
  recordBlock(stats, Number.NaN, 1000);
  recordBlock(stats, -50, 1000);
  recordBlock(stats, 42, Number.NaN);
  assert.equal(longestBlock(stats), 0);

  recordShot(stats, { entryAt: Number.NaN, resolvedAt: 1000 });
  // The sample is still kept - a shot happened - but neither figure claims a number.
  assert.equal(inputLatencyLine(stats), 'Input tap -/- shot -/- n1');
});

test('a resolve time before the entry time is refused', () => {
  const stats = emptyInputStats();
  recordShot(stats, { eventTimeStamp: 1000, entryAt: 1100, resolvedAt: 1000 });
  assert.equal(inputLatencyLine(stats), 'Input tap 100/100 shot -/- n1');
});

// ---- tripwire ----

test('the constants are still the ones the tests above were written against', () => {
  // Every expectation above is a literal. If one of these is retuned the literals stop describing
  // the code, and this is the test that says so rather than one of them failing mysteriously.
  assert.equal(SHOT_SAMPLES, 8);
  assert.equal(BLOCK_WINDOW_MS, 2000);
  assert.equal(MAX_PLAUSIBLE_BLOCK_MS, 1000);
  assert.equal(MAX_PLAUSIBLE_WAIT_MS, 10_000);
});
