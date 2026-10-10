// How well the tracker uses movement at the 50/100 ms detection cadence.
//
// The filters in identify.js are written as time constants rather than per-detection blend
// factors, which makes most of them behave the same in seconds at any detection rate. Most, not
// all - and these tests pin the two places where the rate change from 120/180 ms to 50/100 ms
// actually moved the behaviour, plus the two claims that argue for leaving the rest alone.
//
// Every bound below comes from the old, measured operating point rather than from the constant
// being exercised, so none of them is the constant compared with itself:
//   - 7.5 px of box lag at 400 px/s was the figure BOX_SMOOTHING_TAU_MS was accepted on at the
//     120 ms interval. 10 px is that with headroom.
//   - 0.82 of velocity per update at a 120 ms interval is a 419 ms half-life. 300 ms of coasting
//     is less than one half-life, so more than half the velocity has to survive it.
//   - velocity noise of a one-pole difference quotient is (a/dt) * sigma * sqrt(2/(2-a)) with
//     a = 1 - exp(-dt/tau), and a/dt -> 1/tau as dt -> 0, so shortening the interval can cost at
//     most the gap to that asymptote: 19% from 120 ms. 25% is that with headroom.
//
// Driving the tracker in Node never reaches extractSignature (which needs a canvas) as long as
// every track already has a name and identifyOnce is set: such a track is never due for a check.
// The fake DOM is installed anyway, and only for the failure path: when one of these tests breaks
// by *losing* a track, the replacement is a nameless track that is due at once, and without a
// canvas the test would report `document is not defined` instead of the assertion that matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.js';
import { Tracker } from '../frontend/public/identify.js';

installFakeDom({ videoWidth: 1280, videoHeight: 720 });

const VIDEO = { videoWidth: 1280, videoHeight: 720 };
const H = 180;
const W = 70;
const SPEED = 400; // px/s, the speed the smoothing block was measured at

const box = (x, y = 300) => ({ x: x - W / 2, y: y - H / 2, w: W, h: H, score: 0.9 });
const centre = (track) => track.box.x + track.box.w / 2;

// An already-identified track, so update() associates with it instead of creating a new one.
function named(id, x, t, playerId) {
  return {
    id,
    box: box(x),
    lastSeen: t,
    lastUpdated: t,
    seenThisFrame: true,
    vx: 0,
    vy: 0,
    checks: 3,
    lastCheck: t,
    playerId,
    name: playerId,
    score: 0.8,
    upper: 0.8,
    lower: 0.8,
    grid: 0.8,
    shape: 0.8,
    embed: 0,
    rankings: [],
    debugMatch: null,
    evidence: new Map(),
    evidenceDetails: new Map(),
    streakId: undefined,
    streak: 0,
    misses: 0,
    missedFrames: 0,
    identifiedAt: t,
    identityHits: 2,
    selfRejected: false,
  };
}

function seeded(...tracks) {
  const tracker = new Tracker();
  tracker.tracks = tracks;
  tracker.nextId = tracks.length + 1;
  return tracker;
}

const drive = (tracker, t, ...xs) =>
  tracker.update(xs.map((x) => box(x)), VIDEO, [], 'self', t, { identifyOnce: true });
const coast = (tracker, t) => tracker.update([], VIDEO, [], 'self', t, { identifyOnce: true });

// Walk one person past the tracker at SPEED on a `tick` ms cadence and report how far the drawn
// box ends up behind them.
function settledLag(tick, ticks = 30) {
  const tracker = seeded(named(1, 400, 1000, 'player-a'));
  const step = (SPEED * tick) / 1000;
  let truth = 400;
  let track;
  for (let k = 1; k <= ticks; k++) {
    truth = 400 + k * step;
    track = drive(tracker, 1000 + k * tick, truth)[0];
  }
  return truth - centre(track);
}

// ---- The drawn box's lag, which is also the shot's aim error ----
//
// A one-pole filter sampled every dt settles v * dt * (1 - a) / a behind a target moving at v,
// with a = 1 - exp(-dt/tau). That grows as dt shrinks, toward v * tau - so a faster detection
// rate spends more of the time constant, and the lag the filter was tuned to is not the lag it
// delivers once the rate goes up. tau = 60 trailed the accepted 7.5 px at the old 120 ms and
// trails 15.4 px at 50 ms; this is the regression that costs the aim, since game.js draws and
// shoots the same box.
test('the drawn box trails no further at 20 fps than it was tuned to at 8 fps', () => {
  const searching = settledLag(50);
  const settled = settledLag(100);

  assert.ok(searching > 0, `the box should trail a moving person, not lead them, got ${searching.toFixed(2)} px`);
  assert.ok(
    searching < 10,
    `at the 50 ms searching tier the box should trail about the 7.5 px it was tuned to at 120 ms, got ${searching.toFixed(2)} px`,
  );
  assert.ok(
    settled < 5,
    `the 100 ms settled tier samples more coarsely and must trail less still, got ${settled.toFixed(2)} px`,
  );
  assert.ok(settled < searching, 'a longer interval leaves the filter closer to a pass-through, so it must lag less');
});

// ---- Coasting, the constant the cadence change really did break ----
test("a coasting track's velocity decays per second, not per update", () => {
  // Four ways to spend the same 300 ms of being unseen. A per-update damping factor makes these
  // four different numbers (0.82^6 = 0.30 against 0.82^1 = 0.82); a time constant makes them one.
  const measured = [[50, 6], [100, 3], [150, 2], [300, 1]].map(([tick, ticks]) => {
    const tracker = seeded(named(1, 400, 1000, 'player-a'));
    for (let k = 1; k <= 10; k++) drive(tracker, 1000 + k * 120, 400 + k * 48);
    const before = tracker.tracks[0].vx;
    const t0 = 1000 + 10 * 120;
    for (let k = 1; k <= ticks; k++) coast(tracker, t0 + k * tick);
    return { tick, before, after: tracker.tracks[0].vx };
  });

  for (const { tick, before, after } of measured) {
    assert.ok(after < before, `a track unseen for 300 ms should damp its velocity (${tick} ms ticks)`);
    assert.ok(after > 0, `...but still be moving the same way (${tick} ms ticks), got ${after.toFixed(1)} px/s`);
  }
  const spread = Math.max(...measured.map((m) => m.after)) - Math.min(...measured.map((m) => m.after));
  assert.ok(
    spread < 1,
    `300 ms of coasting should cost the same velocity however it is sliced, got ${measured
      .map((m) => `${m.tick}ms:${m.after.toFixed(1)}`)
      .join(' ')}`,
  );
});

// ---- What that decay is for: reaching a person again after a brief occlusion ----
//
// 0.82 per update at the 120 ms interval it was tuned at is a 419 ms half-life. 300 ms behind a
// pillar is less than one of those, so a person should come out the far side with most of their
// speed - and the detection rate they were lost at must not change that. At 50 ms ticks a
// per-update 0.82 leaves 30% instead, which both under-shoots predictedBox and makes the track
// likelier to be dropped and re-created as a stranger.
test('a 300 ms occlusion at 20 fps leaves a track enough velocity to find its person again', () => {
  const tracker = seeded(named(1, 400, 1000, 'player-a'));
  for (let k = 1; k <= 10; k++) drive(tracker, 1000 + k * 50, 400 + k * 20); // 400 px/s at 50 ms
  const walking = tracker.tracks[0].vx;
  const lost = 1000 + 10 * 50;
  for (let k = 1; k <= 6; k++) coast(tracker, lost + k * 50);

  const coasted = tracker.tracks[0].vx;
  assert.equal(tracker.tracks.length, 1, 'the track should coast, not disappear');
  assert.ok(tracker.tracks[0].missedFrames === 6, `six missed detections, got ${tracker.tracks[0].missedFrames}`);
  assert.ok(
    coasted > walking / 2,
    `300 ms is inside the 419 ms half-life this damping was tuned to, so over half of ${walking.toFixed(
      0,
    )} px/s should survive, got ${coasted.toFixed(0)}`,
  );

  // And the velocity that survived is what carries the prediction to the person: they kept walking
  // and are found 200 px further on, a gap only a projected box reaches. This is also what raising
  // ASSOCIATION_MATCH would cost - a marginal pair here is a correct one.
  const tracks = drive(tracker, lost + 300, 400 + 10 * 20 + 200);
  assert.equal(tracks.length, 1, 'the reappearing person should be the same track, not a stranger');
  assert.equal(tracks[0].id, 1);
  assert.equal(tracks[0].playerId, 'player-a', 'and should still be wearing their name');
});

// ---- Velocity smoothing, which the cadence change did not break ----
//
// Position is a level and velocity is a derivative: a shorter interval quiets a filtered level
// and costs a filtered derivative almost nothing, because the extra differencing noise is paid
// for by the extra averaging. This is why only BOX_SMOOTHING_TAU_MS needed moving.
test('detector jitter becomes no more velocity at 20 fps than it did at 8 fps', () => {
  const rms = (values) => Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
  function noiseAt(tick) {
    let state = 7;
    const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const jitter = () => (random() - 0.5) * 0.03 * H; // the detector noise model from test/motion.test.js
    const centres = [500];
    for (let k = 1; k <= 120; k++) centres.push(500 + jitter());
    const tracker = seeded(named(1, centres[0], 1000, 'player-a'));
    const measured = [];
    for (let k = 1; k <= 120; k++) measured.push(drive(tracker, 1000 + k * tick, centres[k])[0].vx);
    return rms(measured.slice(40)); // settled samples only
  }

  const slow = noiseAt(120);
  const fast = noiseAt(50);
  assert.ok(fast < 15, `a standing person should read near 0 px/s at 20 fps, got ${fast.toFixed(1)} rms`);
  assert.ok(
    fast < slow * 1.25,
    `tripling the detection rate may cost at most the 19% gap to the sigma/tau asymptote, got ${fast.toFixed(
      1,
    )} px/s against ${slow.toFixed(1)}`,
  );
});

// ---- Association: why ASSOCIATION_MATCH stays at 0.3 ----
//
// At 20 fps a person moves 20 px between detections instead of 48, so a correct pair's overlap
// rises (iou of a 70 px-wide box shifted 20 px is 0.56, shifted 48 px it is 0.19) - which looks
// like an argument for tightening the gate against two people being mixed up. It is not: the gate
// only decides whether a pair is considered at all, and in a crossing both candidates clear it
// comfortably, so the best-first ordering decides and the gate is never consulted. What resolves
// the crossing is the velocity prediction, and that is what this pins.
test('two people walking through each other at 20 fps keep their own tracks', () => {
  const tracker = seeded(named(1, 450, 1000, 'player-a'), named(2, 850, 1000, 'player-b'));
  const step = (300 * 50) / 1000; // 300 px/s each, towards each other, at the 50 ms tier
  let left = 450;
  let right = 850;
  for (let k = 1; k <= 20; k++) {
    left += step;
    right -= step;
    const tracks = drive(tracker, 1000 + k * 50, left, right);
    assert.equal(tracks.length, 2, `two people should stay two tracks (step ${k})`);
  }

  // Track 1 started on the left heading right and has to end up on the right, and vice versa:
  // an identity swap at the meeting point shows up as these two being the wrong way round.
  const one = tracker.tracks.find((t) => t.id === 1);
  const two = tracker.tracks.find((t) => t.id === 2);
  assert.ok(left > right, 'the two should have passed each other by now');
  assert.ok(
    Math.abs(centre(one) - left) < step,
    `track 1 should still be on the person it started on, now at ${left}, got ${centre(one).toFixed(0)}`,
  );
  assert.ok(
    Math.abs(centre(two) - right) < step,
    `track 2 should still be on its own person, now at ${right}, got ${centre(two).toFixed(0)}`,
  );
  assert.equal(one.playerId, 'player-a', 'and neither should have taken the other one of their names');
  assert.equal(two.playerId, 'player-b');
});
