import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker } from './identify.js';

function trackedPerson(id, score, lastSeen = 1000) {
  return {
    id,
    box: { x: id * 20, y: 10, w: 80, h: 180, score: 0.9 },
    lastSeen,
    lastUpdated: lastSeen,
    seenThisFrame: true,
    vx: 0,
    vy: 0,
    checks: 3,
    lastCheck: lastSeen,
    playerId: 'player-a',
    name: 'Player A',
    score,
    upper: score,
    lower: score,
    grid: score,
    shape: score,
    embed: 0,
    rankings: [],
    debugMatch: null,
    evidence: new Map(),
    evidenceDetails: new Map(),
    streakId: undefined,
    streak: 0,
    misses: 0,
    missedFrames: 0,
    identifiedAt: lastSeen,
    identityHits: 2,
    lastEnrichedAt: 0,
    selfRejected: false,
  };
}

test('tracker keeps a player tag on only the highest-scoring visible track', () => {
  const tracker = new Tracker();
  tracker.tracks = [trackedPerson(1, 0.62), trackedPerson(2, 0.81)];

  const tracks = tracker.update([], { videoWidth: 640, videoHeight: 480 }, [], 'self', 1010, { closedSet: true });

  assert.equal(tracks.find((track) => track.id === 2).playerId, 'player-a');
  assert.equal(tracks.find((track) => track.id === 1).playerId, null);
});

// ---- Box smoothing and velocity ----
//
// The drawn box has to follow the person closely (detection is only 5-8x a second, so any filter
// lag is on top of an already stale measurement) while track.vx/vy stay quiet, because velocity
// decides box-to-track association and the overlay projects along it between detections. The two
// used to be one number: velocity was inferred from the smoothed box, so less lag meant noisier
// velocity. These tests pin down that they are now independent.
//
// Driving the tracker in Node means never reaching extractSignature, which needs a canvas: a
// track that already has a name, with identifyOnce, is never due for a re-check.
const VIDEO = { videoWidth: 1280, videoHeight: 720 };
const H = 180;
const W = 70;

function movingPerson(x, y = 300) {
  return { x: x - W / 2, y: y - H / 2, w: W, h: H, score: 0.9 };
}

// One pre-seeded, already-identified track at `x`, so update() associates with it instead of
// creating a new one. measuredCenter is deliberately left off: a track from an older frame has
// no such field, and the code has to cope.
function seeded(tracker, x, t) {
  tracker.tracks = [{ ...trackedPerson(1, 0.8, t), box: movingPerson(x), playerId: 'player-a', lastCheck: t }];
  return tracker;
}

const drive = (tracker, t, x) => tracker.update([movingPerson(x)], VIDEO, [], 'self', t, { identifyOnce: true })[0];

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const rms = (values) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);

// How the velocity estimate used to be produced: a single 0.68 blend served as both the drawn
// box and, through the difference of successive smoothed centres, the velocity.
function oldCoupledVelocities(boxes, dtS) {
  let smoothed = boxes[0];
  const out = [];
  for (const box of boxes.slice(1)) {
    const previous = smoothed;
    smoothed = smoothed + 0.68 * (box - smoothed);
    out.push((smoothed - previous) / dtS);
  }
  return out;
}

test('velocity follows the raw detections, in the right direction and at the right speed', () => {
  const tracker = seeded(new Tracker(), 400, 1000);
  let track;
  for (let k = 1; k <= 12; k++) track = drive(tracker, 1000 + k * 120, 400 + k * 48); // 48 px per 120 ms = 400 px/s

  assert.equal(tracker.tracks.length, 1, 'the moving person stayed one track');
  assert.ok(track.vx > 340 && track.vx < 440, `vx should settle near +400 px/s, got ${track.vx.toFixed(0)}`);
  assert.ok(Math.abs(track.vy) < 20, `vy should stay near 0, got ${track.vy.toFixed(0)}`);
});

test('the drawn box trails a moving person far less than the old 0.68 blend did', () => {
  const tracker = seeded(new Tracker(), 400, 1000);
  let track;
  let truth = 400;
  for (let k = 1; k <= 12; k++) {
    truth = 400 + k * 48;
    track = drive(tracker, 1000 + k * 120, truth);
  }
  const lag = truth - (track.box.x + track.box.w / 2);

  // Same series through the old filter, for the comparison this change exists to make.
  let old = 400;
  for (let k = 1; k <= 12; k++) old += 0.68 * (400 + k * 48 - old);
  const oldLag = 400 + 12 * 48 - old;

  assert.ok(lag > 0 && lag < 12, `box should trail by only a few px at 400 px/s, got ${lag.toFixed(1)}`);
  assert.ok(lag < oldLag / 2, `expected less than half the old ${oldLag.toFixed(1)} px of trailing, got ${lag.toFixed(1)}`);
});

test('detector jitter on a standing person does not become velocity', () => {
  const random = rng(7);
  const jitter = () => (random() - 0.5) * 0.03 * H; // the detector noise model from test/motion.test.js
  const centres = [500];
  for (let k = 1; k <= 60; k++) centres.push(500 + jitter());

  const tracker = seeded(new Tracker(), centres[0], 1000);
  const measured = [];
  for (let k = 1; k <= 60; k++) measured.push(drive(tracker, 1000 + k * 120, centres[k]).vx);

  // Settled values only: the first few samples are the filter starting up.
  const settled = measured.slice(20);
  assert.ok(rms(settled) < 40, `a still person should read near 0 px/s, got ${rms(settled).toFixed(0)} rms`);

  // The decoupling has to be an improvement, not a trade: velocity is quieter than the old
  // coupled estimate on the very same detections, even though the box now moves more freely.
  const before = oldCoupledVelocities(centres, 0.12).slice(20);
  assert.ok(
    rms(settled) < rms(before),
    `velocity should be quieter than the old ${rms(before).toFixed(0)} px/s rms, got ${rms(settled).toFixed(0)}`,
  );
});

test('a track coasting through a missed detection keeps a sane velocity when it comes back', () => {
  const tracker = seeded(new Tracker(), 400, 1000);
  for (let k = 1; k <= 8; k++) drive(tracker, 1000 + k * 120, 400 + k * 48);
  const before = tracker.tracks[0].vx;

  // Detection 9 finds nobody; the person keeps walking and is found again at detection 10.
  tracker.update([], VIDEO, [], 'self', 1000 + 9 * 120, { identifyOnce: true });
  assert.equal(tracker.tracks.length, 1, 'the track should coast, not disappear');
  assert.ok(tracker.tracks[0].vx < before, 'a coasting track damps its velocity');

  const track = drive(tracker, 1000 + 10 * 120, 400 + 10 * 48);
  assert.equal(tracker.tracks.length, 1, 'it should re-associate, not spawn a second person');
  assert.equal(track.id, 1);
  assert.ok(track.vx > 250 && track.vx < 520, `vx should stay plausible across the gap, got ${track.vx.toFixed(0)}`);
  assert.ok(Math.abs(track.vy) < 40, `vy should stay near 0 across the gap, got ${track.vy.toFixed(0)}`);
});

test('two detections in quick succession cannot blow the velocity up', () => {
  const tracker = seeded(new Tracker(), 400, 1000);
  for (let k = 1; k <= 8; k++) drive(tracker, 1000 + k * 120, 400 + k * 48);

  // A shot forces an extra detection 1 ms after the scheduled one. Dividing that tiny step by a
  // floored dt overstates the speed enormously; a time-constant blend weights it by ~0.5%.
  const track = drive(tracker, 1000 + 8 * 120 + 1, 400 + 8 * 48 + 2);
  assert.ok(Number.isFinite(track.vx) && Math.abs(track.vx) < 600, `vx should stay bounded, got ${track.vx.toFixed(0)}`);
});

test('a long gap is not mistaken for a velocity measurement', () => {
  const tracker = new Tracker();
  seeded(tracker, 400, 1000);
  for (let k = 1; k <= 8; k++) drive(tracker, 1000 + k * 120, 400 + k * 48);

  // Missed for 480 ms - longer than VELOCITY_MAX_GAP_MS, still inside TRACK_TIMEOUT_MS - and
  // found 150 px further on, which is close enough to still be this track. A person can change
  // direction within half a second, so that straight line is not their current velocity (it
  // would read as 312 px/s): the coasted estimate is kept rather than a confident wrong one.
  // Further than this and the association gate rejects the box outright and starts a new track,
  // which is a different safeguard.
  const t = 1000 + 8 * 120;
  for (const step of [120, 240, 360]) tracker.update([], VIDEO, [], 'self', t + step, { identifyOnce: true });
  const coasted = tracker.tracks[0].vx;
  const track = drive(tracker, t + 480, 400 + 8 * 48 + 150);

  assert.equal(tracker.tracks.length, 1, 'it should still be the same person');
  assert.equal(track.vx, coasted, 'velocity should be left as it was, not recomputed over the gap');
});
