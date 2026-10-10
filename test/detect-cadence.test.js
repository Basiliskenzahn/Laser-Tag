// The detection cadence: how often the loop detects, why it picks the rate it does, and what
// keeps the overlay smooth in between.
//
// The target is 20 fps full detection (a 50 ms interval) while there is anyone on screen still to
// find, and 10 fps when everything in frame is found and named - the slow tier being what pays for
// the fast one. Two things bound that from above and both are tested here: the duty cap, which
// holds a slow phone's rate down instead of letting it stutter, and the camera, since loop() only
// detects on a video frame it has not already seen.
//
// Real here: screens/game.js's loop, its tier choice and its interval arithmetic, plus
// identify.js's tracker. Faked: the camera's pixels, the object detector's answer, the pose
// landmarker and the clock.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakeDom } from './helpers/fake-dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);

const dom = installFakeDom({ videoWidth: 640, videoHeight: 360 });

globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
dom.overlay.clientWidth = 390;
dom.overlay.clientHeight = 844;
Object.assign(dom.overlay.getContext('2d'), {
  font: '',
  fillStyle: '',
  setTransform() {},
  setLineDash() {},
  fillText() {},
});

const game = await import('../frontend/public/screens/game.js');
const { state } = await import('../frontend/public/state.js');

const SELF_ID = 'self-uuid-0001';
const TARGET_ID = 'target-uuid-0002';

// The two tier intervals and the duty share, written as literals. Deriving them from the module
// would make every assertion below `x === x`; a retune has to come past these lines.
const SEARCHING_MS = 50;
const SETTLED_MS = 100;
const BUSY_SHARE = 0.7;

// A counting object detector. Counting the detector rather than refreshGameDetection() is the
// point: it is the synchronous inference the cadence is rationing.
function countingDetector(detections = []) {
  const detector = {
    calls: 0,
    detectForVideo() {
      detector.calls++;
      return { detections };
    },
  };
  return detector;
}

// A pose landmarker that costs measurable time, so its effect on `inferenceMs` - and therefore on
// the next interval through the duty cap - is visible rather than assumed.
function countingPose({ costMs = 0 } = {}) {
  const pose = {
    calls: 0,
    detectForVideo() {
      pose.calls++;
      dom.advance(costMs);
      return { landmarks: [], worldLandmarks: [] };
    },
  };
  return pose;
}

function namedTrack({ x = 100, y = 80, w = 60, h = 200, seenAt, missedFrames = 0, playerId = TARGET_ID } = {}) {
  return {
    id: 1,
    box: { x, y, w, h },
    measuredCenter: { x: x + w / 2, y: y + h / 2 },
    vx: 0,
    vy: 0,
    lastSeen: seenAt,
    lastUpdated: seenAt,
    missedFrames,
    playerId,
    name: playerId ? 'Target' : null,
    identifiedAt: playerId ? seenAt - 2000 : null,
    score: 0.8,
    upper: 0.8,
    lower: 0.8,
    grid: 0.8,
    shape: 0.5,
    embed: 0.5,
    reid: 0,
    hasReid: false,
    selfRejected: false,
    checks: 10,
    lastCheck: 0,
  };
}

// `enrolled` fills both players' galleries. rosterCandidateCount() counts players that *have* a
// gallery, not roster entries, and pose will not run below two of them - so a pose test that
// forgets this measures zero and looks like a passing assertion about cadence.
function arrangeRound({ detector = countingDetector(), pose = null, tracks = [], detectedAt = null, enrolled = false } = {}) {
  const gallery = enrolled ? [{}] : [];
  globalThis.fetch = async () => ({ ok: true, text: async () => '' });
  Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true, configurable: true });
  dom.video.readyState = 2;
  dom.video.currentTime ??= 0;
  const now = dom.now;
  Object.assign(state, {
    myId: SELF_ID,
    room: 'demo',
    mode: 'game',
    game: {
      status: 'playing',
      maxHp: 100,
      minPlayers: 2,
      code: 'demo',
      players: [
        { id: SELF_ID, name: 'Me', hp: 100, alive: true, wins: 0 },
        { id: TARGET_ID, name: 'Target', hp: 100, alive: true, wins: 0 },
      ],
    },
    roster: [
      { id: SELF_ID, name: 'Me', gallery },
      { id: TARGET_ID, name: 'Target', gallery },
    ],
    localGallery: [],
    detector,
    poseDetector: pose,
    embedder: null,
    reid: null,
    tracks,
    boxes: [],
    lastShotAt: 0,
    lastGameDetectAt: detectedAt ?? now,
    lastGamePoseDetectAt: detectedAt ?? now,
    countdownEndsAt: null,
    postProcessingScan: false,
    recordingScan: false,
    bannerOverride: null,
  });
  return { detector, pose };
}

// One turn of the frame loop with a new video frame, so the loop considers detecting.
function frame() {
  dom.video.currentTime += 0.001;
  game.loop();
}

// Run `ms` of wall clock as 1 ms animation frames - fast enough that the frame rate is never what
// limits detection, so what is measured is the cadence and nothing else.
//
// `tracks` is re-installed before every frame, freshly seen. refreshGameDetection() replaces
// state.tracks with the tracker's own output, and with a detector that returns no boxes that output
// is empty - so without this the tier would collapse to `null` the moment the first detection ran,
// and every interval measurement would silently be measuring the settled tier. The tier is read at
// the top of loop(), before the detection, so pinning here is what the loop sees.
function runFor(ms, tracks = []) {
  for (let i = 0; i < ms; i++) {
    state.tracks = tracks.map((track) => ({ ...track, lastSeen: dom.now, lastUpdated: dom.now }));
    frame();
    dom.advance(1);
  }
}

beforeEach(() => {
  dom.element('debug').textContent = '';
  dom.element('crosshair').classes.clear();
});

// ---- which tier, and why ----

test('a coasting track is the strongest signal and outranks everything else', () => {
  // `missedFrames > 0` is a person the detector had and lost - the case the player notices,
  // because the box drifts off someone standing right in front of them. It must win over a track
  // that is merely unnamed, because the two want different work: one wants pose, the other does
  // not.
  arrangeRound({
    tracks: [
      namedTrack({ seenAt: dom.now, missedFrames: 2 }),
      { ...namedTrack({ x: 300, seenAt: dom.now }), id: 2, playerId: null, name: null },
    ],
  });

  assert.equal(game.detectTier(dom.now), 'lost');
});

test('an unnamed track is acquiring, and a named one is neither', () => {
  arrangeRound({ tracks: [{ ...namedTrack({ seenAt: dom.now }), playerId: null, name: null }] });
  assert.equal(game.detectTier(dom.now), 'acquiring');

  arrangeRound({ tracks: [namedTrack({ seenAt: dom.now })] });
  assert.equal(game.detectTier(dom.now), null, 'everything found and named is the slow tier');
});

test('a track too old to be live does not hold the fast tier open', () => {
  // A track that has aged out of LIVE_TRACK_MS is not on screen any more, so neither its missing
  // name nor its missed frames are anything to chase. Without this the tier would latch on a
  // track the drawing has already stopped showing.
  arrangeRound({ tracks: [namedTrack({ seenAt: dom.now - 5000, missedFrames: 4, playerId: null })] });
  assert.equal(game.detectTier(dom.now), null);
});

test('an empty screen is the slow tier, not the fast one', () => {
  arrangeRound({ tracks: [] });
  assert.equal(game.detectTier(dom.now), null);
});

// ---- the rate that comes out ----

test('searching detects at 20 fps and settled at 10 fps', () => {
  // The headline of the branch, measured end to end through the real loop. The detector returns
  // nothing, so no track is created and the tier comes from the tracks the test installed.
  const unnamed = { ...namedTrack({ seenAt: dom.now }), playerId: null, name: null };
  const searching = arrangeRound({ tracks: [unnamed] });
  runFor(1000, [unnamed]);
  const searchingCalls = searching.detector.calls;

  const named = namedTrack({ seenAt: dom.now });
  const settled = arrangeRound({ tracks: [named] });
  runFor(1000, [named]);
  const settledCalls = settled.detector.calls;

  // 1000 ms at a 50 ms interval is 20 detections, at 100 ms it is 10. One either way for where the
  // run starts and stops relative to the interval.
  assert.ok(Math.abs(searchingCalls - 20) <= 1, `searching ran ${searchingCalls} detections, wanted ~20`);
  assert.ok(Math.abs(settledCalls - 10) <= 1, `settled ran ${settledCalls} detections, wanted ~10`);
  assert.ok(searchingCalls > settledCalls, 'the searching tier must actually be the faster one');
});

test('a slow phone has its rate held down by the duty cap, not left to stutter', () => {
  // The cap is what makes 20 fps a target rather than a promise: a detection that costs 35 ms
  // already fills the 50 ms interval at 70% duty, and anything slower must stretch the interval
  // instead of running back to back. 70 ms per detection is 100 ms of interval - 10 fps - and the
  // button keeps its 30% of the thread either way.
  const detector = countingDetector();
  const slow = {
    calls: 0,
    detectForVideo() {
      slow.calls++;
      dom.advance(70);
      return { detections: [] };
    },
  };
  const unnamed = { ...namedTrack({ seenAt: dom.now }), playerId: null, name: null };
  arrangeRound({ detector: slow, tracks: [unnamed] });

  const startedAt = dom.now;
  runFor(400, [unnamed]);
  const elapsed = dom.now - startedAt;
  const interval = elapsed / slow.calls;

  assert.ok(slow.calls > 0, 'the slow phone detected nothing at all');
  // 70 / 0.7 = 100 ms. Not the 50 ms target, and that is the correct answer.
  assert.ok(interval >= 70 / BUSY_SHARE - 12, `interval ${interval.toFixed(0)} ms is faster than the duty cap allows`);
  assert.ok(interval > SEARCHING_MS, 'the duty cap did not stretch the interval at all');
  assert.equal(detector.calls, 0, 'premise: the fast detector was not the one installed');
});

test('detection never outruns the camera', () => {
  // loop() only detects on a video frame it has not seen, so the camera's frame rate is a hard
  // ceiling on the detection rate whatever the interval asks for. A 10 fps camera cannot give
  // 20 fps detection, and the app must not pretend otherwise.
  const unnamed = { ...namedTrack({ seenAt: dom.now }), playerId: null, name: null };
  const { detector } = arrangeRound({ tracks: [unnamed] });

  // 1000 ms of animation frames, but the video only advances ten times.
  for (let i = 0; i < 1000; i++) {
    state.tracks = [{ ...unnamed, lastSeen: dom.now, lastUpdated: dom.now }];
    if (i % 100 === 0) dom.video.currentTime += 0.001;
    game.loop();
    dom.advance(1);
  }

  assert.ok(detector.calls <= 10, `detected ${detector.calls} times from 10 camera frames`);
});

// ---- pose, and what relaxing it costs ----

test('pose is relaxed for a lost track only, and rationed for every other tier', () => {
  // Pose is detector.js's second chance at a person the object detector missed, which is exactly
  // what a coasting track is: rationed at 520 ms normally, 200 ms while someone is lost.
  //
  // All three tiers are measured over the same window, and the window is 1200 ms deliberately. At
  // 400 ms the rationed interval allows one run and the relaxed interval allows one too, so a
  // shorter window cannot tell them apart - it would pass whether the tier gating worked or not.
  // At 1200 ms it is ~2 rationed against ~5 relaxed.
  const WINDOW_MS = 1200;
  const counts = {};
  for (const [tier, track] of [
    ['lost', namedTrack({ seenAt: dom.now, missedFrames: 2 })],
    ['acquiring', { ...namedTrack({ seenAt: dom.now }), playerId: null, name: null }],
    ['settled', namedTrack({ seenAt: dom.now })],
  ]) {
    const { pose } = arrangeRound({ pose: countingPose(), tracks: [track], enrolled: true });
    runFor(WINDOW_MS, [track]);
    counts[tier] = pose.calls;
  }

  // 1200 / 200 = 6 relaxed, 1200 / 520 = 2 rationed.
  assert.ok(counts.lost >= 4, `pose ran only ${counts.lost} times in ${WINDOW_MS} ms while a track was coasting`);
  // Both non-lost tiers stay on the rationed interval. Not asserted as equal to each other: pose
  // can only run on a detection cycle, and those tiers detect at different rates, so the rationed
  // 520 ms lands on a different number of opportunities in each (2 and 1 here). The bound is the
  // claim - at the relaxed interval either would be 5 or 6.
  assert.ok(counts.acquiring <= 2, `pose was relaxed for a merely unnamed track (${counts.acquiring} runs)`);
  assert.ok(counts.settled <= 2, `pose was relaxed with everything found and named (${counts.settled} runs)`);
  assert.ok(
    counts.lost >= counts.acquiring * 2,
    `relaxing pose for 'lost' barely did anything (${counts.lost} vs ${counts.acquiring} acquiring)`,
  );
});

test('pose needs two enrolled players before it runs at all', () => {
  // Its job is telling two people apart and rescuing a missed one; with nobody to confuse it is
  // pure cost. Unchanged by the cadence work, and worth pinning because the tier now gates it too.
  const coasting = namedTrack({ seenAt: dom.now, missedFrames: 2 });
  const { pose } = arrangeRound({ pose: countingPose(), tracks: [coasting], enrolled: true });
  // Exactly the arrangement that ran pose above, with one gallery taken away. The previous test is
  // what makes this a real assertion rather than a tautology about an unenrolled room.
  state.roster = [{ id: SELF_ID, name: 'Me', gallery: [{}] }, { id: TARGET_ID, name: 'Target', gallery: [] }];
  runFor(600, [coasting]);

  assert.equal(pose.calls, 0);
});

// ---- the overlay is not rationed ----

test('the overlay redraws every animation frame, not every detection', () => {
  // The user's floor is "at least 10 fps box painting", and this is why detection can afford to
  // drop to 10 fps without touching it: drawGame() runs on every frame and projects each box along
  // its velocity, so the boxes move smoothly between detections rather than stepping.
  const moving = { ...namedTrack({ seenAt: dom.now }), vx: 100, vy: 0 };
  const { detector } = arrangeRound({ tracks: [moving] });
  const ctx = dom.overlay.getContext('2d');
  let strokes = 0;
  ctx.strokeRect = () => {
    strokes++;
  };

  runFor(20, [moving]);

  // 20 frames, at most one detection in that time (the interval is 50 ms at its fastest).
  assert.ok(detector.calls <= 1, `premise: ${detector.calls} detections in 20 ms, so this proves nothing`);
  assert.ok(strokes >= 20, `the overlay drew ${strokes} times across 20 animation frames`);
});

test('a box with velocity is drawn further along on a frame with no detection', () => {
  // The mechanism behind the test above, measured rather than counted: the same track, drawn two
  // frames apart with no detection in between, must be drawn in two different places.
  arrangeRound({ tracks: [{ ...namedTrack({ x: 100, seenAt: dom.now }), vx: 200, vy: 0 }] });
  const ctx = dom.overlay.getContext('2d');
  const xs = [];
  ctx.strokeRect = (x) => {
    xs.push(x);
  };

  state.tracks[0].lastUpdated = dom.now;
  frame();
  const first = xs[0];
  xs.length = 0;
  dom.advance(40); // no detection: the interval is 50 ms and nothing resets lastGameDetectAt
  frame();
  const later = xs[0];

  assert.ok(Number.isFinite(first) && Number.isFinite(later), 'the track was not drawn');
  assert.ok(later > first, `the projected box did not move (${first} then ${later})`);
});

// ---- identification runs on its own clock ----

// A gallery sample good enough for bestAngleScore to score: it checks every colour field is
// non-empty before comparing, and with `reid` on both sides the re-identification cosine alone
// decides the score (similarityParts).
function galleryFor(vector) {
  return {
    hist: [1, 0, 0, 0],
    lower: [0, 1, 0, 0],
    grid: [0, 0, 1, 0],
    shape: [2.5, 1.4],
    embed: [],
    reid: vector,
    usable: true,
  };
}

// A unit vector, so the live side and the gallery side score a cosine of exactly 1 - which clears
// reidInitialLock() and names the track on its first check. That is deliberate here: this test is
// about the rate a *named* track is re-checked at, so getting it named must not itself take five
// checks and skew the window.
const REID_VECTOR = Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0));

test('an unnamed track is checked on every detection, not at the recheck interval', () => {
  // A track with no identity is the one case that bypasses RECHECK_MS entirely: it is due every
  // cycle, because the whole point is to name it as fast as the loop runs. With the searching tier
  // at 20 fps that is 20 checks a second.
  let latest = 0;
  const reid = {
    latest() {
      latest++;
      return null; // never resolves, so the track stays unnamed for the whole window
    },
    request() {},
  };
  const box = { x: 220, y: 60, w: 70, h: 220 };
  const detector = countingDetector([
    { boundingBox: { originX: box.x, originY: box.y, width: box.w, height: box.h }, categories: [{ score: 0.9 }] },
  ]);
  arrangeRound({ detector, tracks: [] });
  state.reid = reid;

  const startedAt = dom.now;
  for (let i = 0; i < 1000; i++) {
    frame();
    dom.advance(1);
  }
  const seconds = (dom.now - startedAt) / 1000;

  assert.equal(state.tracks.length, 1, `premise: wanted one track, got ${state.tracks.length}`);
  assert.equal(state.tracks[0].playerId, null, 'premise: the track must have stayed unnamed');
  const hz = latest / seconds;
  assert.ok(hz >= 15, `an unnamed track was only checked ${hz.toFixed(1)} times a second`);
});

test('a named track is re-checked at 10 Hz, and OSNet is asked at roughly half that', () => {
  // The user's two floors are separate numbers, and this is the decoupling that lets both hold:
  // re-deciding who a *named* track is happens at RECHECK_MS (100 ms, 10 Hz), while asking reid.js
  // for a fresh embedding happens at REID_REQUEST_MS (220 ms, ~4.5 Hz).
  //
  // The split exists because the two cost wildly different amounts. A check is box arithmetic, a
  // reid.latest() lookup and a few gallery cosines. A *request* runs getImageData(128, 256) - a
  // 32k-pixel GPU-to-CPU readback - synchronously on the main thread before the crop goes to the
  // worker, so at 10 Hz with four people in frame it would be ~1.3 Mpx of readback a second on the
  // thread the FIRE button needs.
  //
  // Counted through reid's own interface: `latest` is called once per due check and `request` once
  // per accepted request, so the two counts are the two rates.
  let latest = 0;
  let requests = 0;
  const reid = {
    latest() {
      latest++;
      return REID_VECTOR;
    },
    request() {
      requests++;
    },
  };

  // A real box, so the tracker makes and keeps its own track: the request throttle is per-track
  // state, and a track the test replaced every frame would never reach it.
  const box = { x: 220, y: 60, w: 70, h: 220 };
  const detector = countingDetector([
    { boundingBox: { originX: box.x, originY: box.y, width: box.w, height: box.h }, categories: [{ score: 0.9 }] },
  ]);
  arrangeRound({ detector, tracks: [] });
  state.reid = reid;
  state.roster = [
    { id: SELF_ID, name: 'Me', gallery: [] },
    { id: TARGET_ID, name: 'Target', gallery: [galleryFor(REID_VECTOR)] },
  ];

  // Let it get named first, then measure. Counting from zero would mix the every-cycle unnamed
  // rate into the named rate and report something in between.
  for (let i = 0; i < 200; i++) {
    frame();
    dom.advance(1);
  }
  assert.equal(state.tracks.length, 1, `premise: wanted one track, got ${state.tracks.length}`);
  assert.equal(state.tracks[0].playerId, TARGET_ID, 'premise: the track must be named before the window starts');

  latest = 0;
  requests = 0;
  const startedAt = dom.now;
  for (let i = 0; i < 2000; i++) {
    frame();
    dom.advance(1);
  }
  const seconds = (dom.now - startedAt) / 1000;

  assert.equal(state.tracks[0].playerId, TARGET_ID, 'premise: and still named at the end');
  const idHz = latest / seconds;
  const reqHz = requests / seconds;

  // 10 Hz identification. Note this is also the detection rate here: a named, non-coasting track
  // is the settled tier, so detection is 10 fps and a check is due on every one of them. The floor
  // is met from both directions, which is why the settled tier was set at 10 and not lower.
  assert.ok(idHz >= 8, `identification ran at ${idHz.toFixed(1)} Hz, under the 10 Hz floor`);
  // ...and the embedding behind it at ~4.5 Hz, which must be clearly slower.
  assert.ok(reqHz <= 6, `OSNet was asked ${reqHz.toFixed(1)} times a second, so it is not decoupled`);
  assert.ok(
    reqHz < idHz * 0.75,
    `requests (${reqHz.toFixed(1)} Hz) are not meaningfully slower than checks (${idHz.toFixed(1)} Hz)`,
  );
});
