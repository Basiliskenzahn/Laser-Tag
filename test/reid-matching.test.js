// Matching rules once signatures carry a person re-identification embedding (frontend/public/reid.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageSignatures, matchGallery } from '../frontend/public/identify.js';

// A random unit vector; random high-dimensional vectors are nearly orthogonal to each other.
function unit(n, seed) {
  let state = seed >>> 0 || 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) || 1e-12;
  const v = Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

let nextSeed = 100;

// A unit vector at a chosen cosine similarity to `base`, off in its own random direction (so two
// such vectors aren't accidentally similar to each other).
function similarTo(base, cosine) {
  const other = unit(base.length, nextSeed++);
  const dot = other.reduce((s, v, i) => s + v * base[i], 0);
  const orth = other.map((v, i) => v - dot * base[i]);
  const norm = Math.hypot(...orth);
  return base.map((v, i) => cosine * v + Math.sqrt(1 - cosine ** 2) * (orth[i] / norm));
}

// Colour parts that look like a strong match, so only the re-identification score can say no.
const colours = { hist: unit(64, 1), lower: unit(64, 2), grid: unit(192, 3), shape: [2.5, 0.5], embed: unit(256, 4) };
const rexReid = unit(512, 10);
const kaiReid = unit(512, 20);
const players = [
  { id: 'rex', name: 'Rex', gallery: [{ ...colours, reid: rexReid }, { ...colours, reid: similarTo(rexReid, 0.95) }] },
  { id: 'kai', name: 'Kai', gallery: [{ ...colours, reid: kaiReid }] },
];
const person = (reid) => ({ ...colours, reid });

test('the re-identification score decides when both sides have one', () => {
  const m = matchGallery(person(similarTo(rexReid, 0.85)), players, null, { closedSet: true });
  assert.equal(m.id, 'rex');
  assert.equal(m.hasReid, true);
  assert.equal(m.accepted, true);
  assert.ok(Math.abs(m.reid - 0.85) < 0.01);
});

test('a bystander is rejected even in closed-set mode, although the colours match', () => {
  const m = matchGallery(person(similarTo(rexReid, 0.55)), players, null, { closedSet: true, includeRejected: true });
  assert.equal(m.accepted, false);
  assert.equal(m.reason, 'score');
});

test('two players scoring almost the same is a tie, not a guess', () => {
  // Equally similar to Rex and Kai.
  const between = rexReid.map((v, i) => v + kaiReid[i]);
  const norm = Math.hypot(...between);
  const m = matchGallery(person(between.map((v) => v / norm)), players, null, { closedSet: true, includeRejected: true });
  if (m.score >= 0.72) assert.equal(m.reason, 'margin');
  else assert.equal(m.accepted, false);
});

test('galleries without re-identification keep the old colour behaviour', () => {
  const old = players.map((p) => ({ ...p, gallery: p.gallery.map(({ reid, ...rest }) => rest) }));
  const m = matchGallery(person(similarTo(rexReid, 0.55)), old, null, { closedSet: true });
  assert.equal(m.hasReid, false);
  assert.equal(m.accepted, true); // closed set still takes the best colour match
});

test('averaged scan samples keep a normalised re-identification embedding', () => {
  const avg = averageSignatures([person(rexReid), person(similarTo(rexReid, 0.9))]);
  assert.equal(avg.reid.length, 512);
  assert.ok(Math.abs(Math.hypot(...avg.reid) - 1) < 1e-9);
  assert.equal(averageSignatures([colours]).reid.length, 0);
});

test('a named track whose re-identification no longer fits its player loses the name', async () => {
  const { Tracker } = await import('../frontend/public/identify.js');
  const video = { videoWidth: 640, videoHeight: 480 };
  const box = { x: 250, y: 60, w: 120, h: 360, score: 0.9 };
  let current = similarTo(rexReid, 0.95);
  const reid = { latest: () => current, request() {} }; // stands in for reid.js's background embedder
  const tracker = new Tracker();
  let now = 1000;
  const step = () => tracker.update([{ ...box }], video, players, 'self', (now += 300), { reid, closedSet: true })[0];
  let track;
  // Enough checks to win INITIAL_STREAK: this score clears the accept threshold but not
  // reidInitialLock(), so the name comes from the streak rather than from one strong check.
  for (let i = 0; i < 6; i++) track = step();
  assert.equal(track.playerId, 'rex');

  // Someone else steps into the same spot: the box carries on, but they look nothing like Rex.
  //
  // Revocation needs REID_REVOKE_CHECKS consecutive raw misses *and* the median - the score that
  // granted the name, and that grants the shot - to have stopped clearing the accept floor
  // (identify.js revokedByReid). REID_REVOKE_CHECKS is 8, which at RECHECK_MS (100 ms) is 800 ms
  // of sustained mismatch: the count is a stand-in for that duration, and it was raised from 3
  // when the identification rate went from 4 Hz to 10 Hz. Had it not been, a 300 ms motion-blur
  // burst would now cost a real player their name - which is what the next test guards.
  current = similarTo(rexReid, 0.3);
  for (let i = 0; i < 7; i++) {
    track = step();
    assert.equal(track.playerId, 'rex', `bad check ${i + 1} of 7 must not be enough on its own`);
  }
  track = step();
  assert.equal(track.playerId, null, 'the eighth consecutive miss drops the name');
});

test('the threshold can be tuned in the field (?reid=)', async () => {
  const { setReidThreshold, getReidThreshold } = await import('../frontend/public/identify.js');
  const before = getReidThreshold();
  const probe = person(similarTo(rexReid, 0.8));
  try {
    setReidThreshold(0.85);
    assert.equal(matchGallery(probe, players, null, { closedSet: true, includeRejected: true }).accepted, false);
    setReidThreshold(0.7);
    assert.equal(matchGallery(probe, players, null, { closedSet: true }).accepted, true);
    setReidThreshold(5); // nonsense is ignored
    assert.equal(getReidThreshold(), 0.7);
  } finally {
    setReidThreshold(before);
  }
});

// Feeds one tracked box a sequence of re-identification scores against Rex, one check every
// 300 ms, and returns the track after each check.
async function trackScores(scores) {
  const { Tracker } = await import('../frontend/public/identify.js');
  const video = { videoWidth: 640, videoHeight: 480 };
  const box = { x: 250, y: 60, w: 120, h: 360, score: 0.9 };
  let current;
  const reid = { latest: () => current, request() {} };
  const tracker = new Tracker();
  let now = 1000;
  return scores.map((score) => {
    current = similarTo(rexReid, score);
    const track = tracker.update([{ ...box }], video, players, 'self', (now += 300), { reid, closedSet: true })[0];
    return { playerId: track.playerId, score: track.score };
  });
}

test('a brief spike from someone who usually scores low does not name them', async () => {
  const steps = await trackScores([0.62, 0.64, 0.6, 0.63, 0.65, 0.62, 0.79, 0.8, 0.78, 0.63, 0.61]);
  assert.ok(steps.every((s) => s.playerId == null), JSON.stringify(steps));
});

test('a player who usually scores high keeps their name and stays shootable through a dip', async () => {
  const { reidTargetMinScore } = await import('../frontend/public/identify.js');
  const steps = await trackScores([0.84, 0.86, 0.83, 0.85, 0.87, 0.6, 0.84, 0.86]);
  assert.equal(steps[4].playerId, 'rex');
  for (const s of steps.slice(4)) {
    assert.equal(s.playerId, 'rex');
    assert.ok(s.score >= reidTargetMinScore(), `score ${s.score} after a dip`);
  }
});


test('a new track needs INITIAL_STREAK agreeing checks, which is a duration not a count', async () => {
  const { Tracker } = await import('../frontend/public/identify.js');
  // INITIAL_STREAK is 5, and the reason it is not 2 any more is the detection rate. An
  // unidentified track is due on *every* detection cycle, so the streak runs at the detection
  // interval - and that interval went from 120 ms to 50 ms. Two checks 50 ms apart are not two
  // independent observations: reid.latest() keeps one embedding usable for 800 ms, so both checks
  // can score the very same vector. Five checks at 50 ms span a fresh request (REID_REQUEST_MS,
  // 220 ms), which is what makes the streak evidence rather than repetition.
  //
  // The score here clears the accept threshold but stays under reidInitialLock(), so the streak is
  // the only thing that can name this track - a stronger score would be named on one check and
  // this test would prove nothing.
  const video = { videoWidth: 640, videoHeight: 480 };
  const box = { x: 250, y: 60, w: 120, h: 360, score: 0.9 };
  const current = similarTo(rexReid, 0.74);
  const premise = matchGallery(person(current), players, 'self', { closedSet: true, includeRejected: true });
  assert.equal(premise.id, 'rex', 'premise: Rex is the match');
  assert.equal(premise.accepted, true, 'premise: and an accept, so only the streak withholds the name');
  assert.ok(premise.score < 0.8, `premise: ${premise.score} must stay under reidInitialLock()`);

  const reid = { latest: () => current, request() {} };
  const tracker = new Tracker();
  let now = 1000;
  const step = () => tracker.update([{ ...box }], video, players, 'self', (now += 300), { reid, closedSet: true })[0];

  let track;
  for (let i = 1; i <= 4; i++) {
    track = step();
    assert.equal(track.playerId, null, `check ${i} of 4 must not be enough to name a brand new track`);
  }
  track = step();
  assert.equal(track.playerId, 'rex', 'the fifth agreeing check names it');
});
