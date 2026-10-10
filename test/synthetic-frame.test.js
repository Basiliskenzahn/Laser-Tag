// The shared synthetic frame fixture (test/fixtures/synthetic-frame.mjs).
//
// This fixture is the ground truth for both test/shape-signature.test.js and
// tools/shape-evaluation.mjs, so a silent change to it moves a regression test and a measurement
// at the same time without either one complaining. `sensorGrid` was added for the box-scale
// sweep; these tests hold down that it does what it claims AND that it is off by default, which
// is the property that keeps every existing caller unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND, bands, frame } from './fixtures/synthetic-frame.mjs';

const BOX = { x: 100, y: 100, w: 40, h: 120 };
const PAINT = bands({ head: [200, 180, 160], shirt: [40, 90, 200], accent: [240, 200, 20], trousers: [30, 30, 40] });
const PEOPLE = [{ box: BOX, paint: PAINT }];

test('by default a frame answers at the exact position asked, to any precision', () => {
  // This is the behaviour every existing caller was written against: `paint` is an analytic
  // function of position. Two reads a fifth of a pixel apart straddling a band edge differ.
  const f = frame(PEOPLE);
  const edge = BOX.y + BOX.h * 0.14; // the head/shirt boundary in bands()
  assert.notDeepEqual(f.pixel(BOX.x + 20, edge - 0.2), f.pixel(BOX.x + 20, edge + 0.2));
});

test('sensorGrid quantises reads to the pixel lattice', () => {
  // Every read inside one source pixel must come back identical, because a real sensor only
  // sampled that pixel once. This is what stops a small box being invented detail it never had.
  const f = frame(PEOPLE, { sensorGrid: true });
  const base = f.pixel(BOX.x + 20.1, BOX.y + 30.1);
  for (const [dx, dy] of [
    [0, 0],
    [0.4, 0],
    [0, 0.4],
    [0.8, 0.8],
  ]) {
    assert.deepEqual(f.pixel(BOX.x + 20.1 + dx, BOX.y + 30.1 + dy), base);
  }
  // And a read in the next pixel along is allowed to differ - if it were not, the fixture would
  // be returning one colour for the whole box.
  const across = [];
  for (let x = BOX.x; x < BOX.x + BOX.w; x++) across.push(f.pixel(x + 0.5, BOX.y + 30.5).join(','));
  assert.ok(new Set(across).size > 1, 'the whole row came back as one colour');
});

test('sensorGrid freezes per-pixel noise instead of redrawing it on every read', () => {
  // The fixture used to pull a fresh random at every sampled point, so a 12-px-wide box got as
  // many independent noise samples as a 300-px one and averaged them away just as well. That is
  // exactly the advantage a distant crop does not have.
  let calls = 0;
  const noisy = [{ box: BOX, paint: bands({ head: [128, 128, 128], shirt: [128, 128, 128], accent: [128, 128, 128], trousers: [128, 128, 128], noise: () => (calls++ % 2 ? 40 : -40) }) }];

  const analytic = frame(noisy);
  const a1 = analytic.pixel(BOX.x + 5.1, BOX.y + 5.1);
  const a2 = analytic.pixel(BOX.x + 5.1, BOX.y + 5.1);
  assert.notDeepEqual(a1, a2, 'the analytic frame should redraw noise, as it always has');

  calls = 0;
  const quantised = frame(noisy, { sensorGrid: true });
  const q1 = quantised.pixel(BOX.x + 5.1, BOX.y + 5.1);
  const q2 = quantised.pixel(BOX.x + 5.4, BOX.y + 5.4);
  assert.deepEqual(q1, q2, 'the same sensor pixel must keep the noise it was drawn with');
  assert.equal(calls, 1, 'noise should be drawn once per sensor pixel, not once per read');
});

test('sensorGrid changes nothing else about the frame', () => {
  const plain = frame(PEOPLE, { width: 320, height: 240 });
  const grid = frame(PEOPLE, { width: 320, height: 240, sensorGrid: true });
  assert.equal(grid.videoWidth, 320);
  assert.equal(grid.videoHeight, 240);
  // Outside every box, both report the background.
  assert.deepEqual(grid.pixel(5.5, 5.5), BACKGROUND);
  assert.deepEqual(plain.pixel(5.5, 5.5), BACKGROUND);
  // Sampled at pixel centres - where the quantised frame samples anyway - they agree exactly.
  for (const [x, y] of [
    [120.5, 130.5],
    [135.5, 190.5],
    [100.5, 100.5],
  ]) {
    assert.deepEqual(grid.pixel(x, y), plain.pixel(x, y), `disagreement at ${x},${y}`);
  }
});
