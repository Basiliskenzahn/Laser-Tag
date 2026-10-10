import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseMotion, motionCheck, resample, visualActivity } from '../public/motion/matching.js';

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

test('fusion: confirm, veto, correct, or fall back to the classifier', () => {
  const opponents = [{ id: 'rex', name: 'Rex' }, { id: 'kai', name: 'Kai' }];
  const ok = { status: 'consistent', correlation: 0.8 };
  const bad = { status: 'inconsistent', correlation: -0.1 };
  const none = { status: 'unknown' };
  const fuse = (classifier, checks) => fuseMotion({ classifier, opponents, checks });

  assert.equal(fuse({ playerId: 'rex', confident: false }, { rex: ok }).reason, 'confirmed');
  assert.equal(fuse({ playerId: 'rex', confident: true }, { rex: bad }).reason, 'vetoed');
  assert.equal(fuse({ playerId: 'rex', confident: true, candidates: ['rex', 'kai'] }, { rex: bad, kai: ok }).playerId, 'kai');
  assert.equal(fuse({ playerId: 'rex', confident: true }, { rex: none }).reason, 'classifier-only');
  assert.equal(fuse({ playerId: 'rex', confident: false }, { rex: none }).playerId, null);
  assert.equal(fuse({ playerId: null }, { rex: ok, kai: bad }).playerId, 'rex');
  assert.equal(fuse({ playerId: null }, { rex: ok, kai: ok }).reason, 'ambiguous');
  assert.equal(fuse({ self: true }, { rex: ok }).reason, 'self');
  assert.equal(fuseMotion({ classifier: { playerId: 'rex', confident: true }, opponents, checks: { rex: none }, requireMotion: true }).playerId, null);
});
