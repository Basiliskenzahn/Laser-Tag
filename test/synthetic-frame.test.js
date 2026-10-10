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

// A paint that varies with every fraction of a pixel, so "did this read move?" has an answer at
// any precision. `bands` cannot be used for that: it is piecewise flat, so two reads inside the
// same band agree whether or not they were quantised, and a test built on it would pass with the
// quantisation removed entirely.
const GRADIENT = [{ box: BOX, paint: (u, v) => [Math.round(u * 255), Math.round(v * 255), 0] }];
const SUB_PIXEL = [BOX.x + 20.2, BOX.y + 30.2];
const SAME_PIXEL = [BOX.x + 20.8, BOX.y + 30.8]; // floor()s to the same pixel as SUB_PIXEL

test('by default a frame answers at the exact position asked, to any precision', () => {
  // The behaviour every existing caller was written against: `paint` is an analytic function of
  // position. Two reads inside ONE source pixel still differ - which is exactly the thing a real
  // sensor cannot do, and the reason `sensorGrid` exists.
  const f = frame(GRADIENT);
  assert.notDeepEqual(f.pixel(...SUB_PIXEL), f.pixel(...SAME_PIXEL));
  // And on the banded paint, either side of a band edge that falls mid-pixel.
  const banded = frame(PEOPLE);
  const edge = BOX.y + BOX.h * 0.14; // 116.8: the head/shirt boundary, inside pixel row 116
  assert.notDeepEqual(banded.pixel(BOX.x + 20.5, edge - 0.3), banded.pixel(BOX.x + 20.5, edge + 0.2));
});

test('sensorGrid quantises reads to the pixel lattice', () => {
  // Every read inside one source pixel must come back identical, because a real sensor only
  // sampled that pixel once. This is what stops a small box being given detail it never had.
  const f = frame(GRADIENT, { sensorGrid: true });
  const base = f.pixel(...SUB_PIXEL);
  assert.deepEqual(f.pixel(...SAME_PIXEL), base, 'two reads in one sensor pixel disagreed');
  for (const [dx, dy] of [
    [0, 0],
    [0.4, 0],
    [0, 0.4],
    [0.7, 0.7],
  ]) {
    assert.deepEqual(f.pixel(SUB_PIXEL[0] + dx, SUB_PIXEL[1] + dy), base);
  }
  // The value is the pixel's centre, not the position asked for.
  assert.deepEqual(base, f.pixel(Math.floor(SUB_PIXEL[0]) + 0.5, Math.floor(SUB_PIXEL[1]) + 0.5));
  // And the next pixel along does differ - otherwise the fixture would be returning one colour
  // for the whole box, which would "pass" quantisation by destroying everything.
  assert.notDeepEqual(f.pixel(SUB_PIXEL[0] + 1, SUB_PIXEL[1]), base);
  assert.notDeepEqual(f.pixel(SUB_PIXEL[0], SUB_PIXEL[1] + 1), base);
  const across = new Set();
  for (let x = BOX.x; x < BOX.x + BOX.w; x++) across.add(f.pixel(x + 0.5, BOX.y + 30.5).join(','));
  assert.equal(across.size, BOX.w, 'a 40-px-wide box should have 40 distinct columns, not fewer');
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
