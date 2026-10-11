// The correlation maths behind motion confirmation (frontend/public/motion/matching.js).
//
// READ THIS BEFORE QUOTING A NUMBER OUT OF THIS FILE. Everything below is a SIMULATION. The
// "player" is a scripted stand/walk pattern turned into a clean 10 Hz activity series, and the
// "camera" is a box sliding across a frame with uniform jitter. It is deterministic (its own
// rng() rather than Math.random) and statistical over 30 seeds, which is what makes it a useful
// regression test: it pins the maths against a fixed noise model, so a change that breaks the
// correlation shows up. It is NOT evidence about a real room, and the pass rates it asserts are
// not accuracy figures. No part of this module has ever been compared against a real
// accelerometer - see the header of matching.js for the list of field conditions this cannot
// produce.
//
// The decision rules are not here: motion may only confirm an identity appearance already
// arrived at, and that property is tested against the real target.js in target-motion.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionCheck, resample, visualActivity } from '../frontend/public/motion/matching.js';

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

// A person alternating between standing (aiming) and moving (walking, dodging) at random times.
function schedule(seconds, seed) {
  const random = rng(seed);
  const segments = [];
  for (let t = 0, moving = random() < 0.5; t < seconds; moving = !moving) {
    const length = moving ? 0.6 + random() * 1.6 : 0.5 + random() * 1.5;
    segments.push({ from: t, to: t + length, moving });
    t += length;
  }
  return (t) => segments.find((s) => t >= s.from && t < s.to)?.moving ?? false;
}

// What that person's own phone reports: accelerometer activity (m/s^2) at 10 Hz on its clock.
function phoneActivity(isMoving, seconds, { clockOffsetMs = 0, seed = 1 } = {}) {
  const random = rng(seed);
  const out = [];
  for (let t = 0; t < seconds; t += 0.1) out.push({ t: t * 1000 + clockOffsetMs, v: (isMoving(t) ? 1.8 : 0.15) + 0.25 * random() });
  return out;
}

// What another phone's camera sees: the person's box at ~7 detections per second, with
// detector jitter, moving sideways while walking.
function cameraBoxes(isMoving, seconds, { seed = 2, h = 300 } = {}) {
  const random = rng(seed);
  const out = [];
  let x = 200;
  let direction = 1;
  for (let t = 0; t < seconds; t += 0.14) {
    if (isMoving(t)) x += direction * 0.6 * h * 0.14; // 0.6 body heights per second
    if (x > 900 || x < 100) direction = -direction;
    const jitter = () => (random() - 0.5) * 0.03 * h;
    out.push({ t: t * 1000, box: { x: x + jitter(), y: 100 + jitter(), w: h / 3, h: h + jitter() } });
  }
  return out;
}

const SECONDS = 16;
const now = SECONDS * 1000 - 200;

test('resample interpolates and leaves gaps empty', () => {
  const series = [{ t: 0, v: 0 }, { t: 200, v: 2 }, { t: 2000, v: 5 }];
  const r = resample(series, 400, 500);
  assert.deepEqual(r.slice(0, 3), [0, 1, 2]);
  assert.equal(r[4], null); // 400 ms: next sample is 1.8 s away
});

test('the player in view matches their own phone', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const moving = schedule(SECONDS, seed);
    const c = motionCheck({ visual: visualActivity(cameraBoxes(moving, SECONDS, { seed })), remote: phoneActivity(moving, SECONDS, { seed }), now });
    assert.equal(c.status, 'consistent', `seed ${seed}: ${JSON.stringify(c)}`);
  }
});

test('a bystander moving on their own does not match the player\'s phone', () => {
  let consistent = 0;
  let inconsistent = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const player = schedule(SECONDS, seed);
    const bystander = schedule(SECONDS, seed + 100);
    const c = motionCheck({ visual: visualActivity(cameraBoxes(bystander, SECONDS, { seed })), remote: phoneActivity(player, SECONDS, { seed }), now });
    if (c.status === 'consistent') consistent++;
    if (c.status === 'inconsistent') inconsistent++;
  }
  assert.ok(consistent <= 2, `${consistent}/30 bystanders matched a player's phone`);
  assert.ok(inconsistent >= 12, `only ${inconsistent}/30 bystanders were clearly rejected`);
});

test('tolerates the phones\' clocks being a few hundred ms apart', () => {
  const moving = schedule(SECONDS, 7);
  const c = motionCheck({ visual: visualActivity(cameraBoxes(moving, SECONDS)), remote: phoneActivity(moving, SECONDS, { clockOffsetMs: 300 }), now });
  assert.equal(c.status, 'consistent');
  assert.ok(Math.abs(c.lagMs - 300) <= 100, `lag ${c.lagMs}`); // the correlation peak is broad
});

test('no decision when nobody moves', () => {
  const still = () => false;
  const c = motionCheck({ visual: visualActivity(cameraBoxes(still, SECONDS)), remote: phoneActivity(still, SECONDS), now });
  assert.equal(c.status, 'unknown');
});

test('moments when the shooter pans the camera are ignored', () => {
  const moving = schedule(SECONDS, 9);
  const visual = visualActivity(cameraBoxes(moving, SECONDS));
  const remote = phoneActivity(moving, SECONDS);
  // The shooter's own phone reports whether it's turning, 10x a second like the real sensor.
  const ego = (isPanning) => Array.from({ length: SECONDS * 10 }, (_, i) => ({ t: i * 100, v: isPanning(i * 100) ? 1 : 0 }));
  // Panning the whole time: nothing usable.
  assert.equal(motionCheck({ visual, remote, ego: ego(() => true), now }).status, 'unknown');
  // A quick pan throws the image motion off for half a second. Unmasked, that breaks the match;
  // masked, it still holds.
  const corrupted = visual.map((s) => (s.t > 12000 && s.t < 12600 ? { ...s, v: 5 } : s));
  const pan = ego((t) => t >= 11900 && t <= 12700);
  assert.notEqual(motionCheck({ visual: corrupted, remote, now }).status, 'consistent');
  assert.equal(motionCheck({ visual: corrupted, remote, ego: pan, now }).status, 'consistent');
});

// ---- the guards, each of which stands for a crash or a wrong answer that was reachable ----

test('a box too small to measure is skipped instead of dividing by its height', () => {
  // visualActivity divides the box centre's travel by the box height. The old documentation said
  // detectTrackedPeople() filtered boxes to h > 8 so this could not be reached; the filter is on
  // the POSE boxes only (detector.js), and every box from the object detector arrives unfiltered.
  // A zero-height box therefore reached the division, and the Infinity it produced became NaN
  // inside the correlation.
  const at = (t, h) => ({ t, box: { x: t, y: 0, w: 10, h } });
  const degenerate = [at(0, 0), at(100, 0), at(200, 0)];
  assert.deepEqual(visualActivity(degenerate), [], 'no samples at all, rather than Infinity');

  const tiny = visualActivity([at(0, 3), at(100, 3)]);
  assert.deepEqual(tiny, [], 'a 3 px box is detector jitter, not a measurable person');

  // And the guard must not be eating ordinary people: the same motion on a real-sized box does
  // produce a sample, and a finite one.
  const real = visualActivity([at(0, 300), at(100, 300)]);
  assert.equal(real.length, 1);
  assert.ok(Number.isFinite(real[0].v) && real[0].v > 0, `got ${real[0]?.v}`);
});

test('a non-finite coordinate anywhere in a pair produces no sample', () => {
  const boxes = [
    { t: 0, box: { x: NaN, y: 0, w: 10, h: 300 } },
    { t: 100, box: { x: 50, y: 0, w: 10, h: 300 } },
    { t: 200, box: { x: 100, y: 0, w: 10, h: 300 } },
  ];
  const out = visualActivity(boxes);
  assert.equal(out.length, 1, 'only the clean pair survives');
  assert.ok(Number.isFinite(out[0].v));
});

test('a partial motionCheck call answers "unknown" instead of throwing', () => {
  // fuseMotion({classifier, opponents, checks}) had no defaults for opponents or checks and threw
  // on a partial call; it was documented as unreachable and is now gone entirely, because an
  // additive-only signal has nothing to arbitrate. motionCheck is the entry point that survives,
  // and it had the same defect one level down: a missing series threw out of resample() on
  // `series.length`, so a caller that forgot an argument failed as a crash in the frame loop
  // rather than as "no opinion".
  for (const args of [{ now: 1000 }, { visual: [], now: 1000 }, { remote: [], now: 1000 }]) {
    const c = motionCheck(args);
    assert.equal(c.status, 'unknown', `${JSON.stringify(args)} -> ${JSON.stringify(c)}`);
  }
});
