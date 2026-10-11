// Movement as a detection signal: what the frame differencing will and will not claim, and what
// the detection loop does about it.
//
// Real here: frame-motion.js's whole pixel path (the downscale, the readback, the exposure
// normalisation, the diff, the cell grid, the global-motion reject and the hold/refractory),
// detector.js's coverage geometry, screens/game.js's loop, its tier choice and its interval
// arithmetic, and identify.js's tracker. Faked: the camera's pixels, the object detector's
// answer, the pose landmarker and the clock.
//
// Two notes on reading these tests. The frames are painted by hand, and the fake canvas
// downscales nearest-neighbour rather than area-averaging as a browser does - so these pin
// *behaviour* (a mover hints, a pan does not, the hold expires) and deliberately do not try to
// re-derive the detectability floor or the thresholds. Those came from an area-averaging
// measurement over synthetic 720p frames, tabulated in docs/client/detection.md. And the movers
// here are large and high-contrast on purpose: a test sitting on the edge of a threshold tells
// you about the threshold rather than about the mechanism.
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
const motion = await import('../frontend/public/frame-motion.js');
const { state } = await import('../frontend/public/state.js');

const SELF_ID = 'self-uuid-0001';
const TARGET_ID = 'target-uuid-0002';

// The two tier intervals, written as literals for the same reason detect-cadence.test.js writes
// them: derived from the module they would make every assertion below x === x.
const SEARCHING_MS = 50;
const SETTLED_MS = 100;

// ---- watching the readback ----
//
// getImageData is the one part of this that is not arithmetic - on a phone it is a GPU->CPU
// transfer - so "how many did we do" is the cost claim worth holding down, and it is counted
// rather than argued. Wrapping the shared context prototype counts *every* readback in the
// process, identify.js's colour features included, so calls are tagged with the canvas they came
// from and frame-motion.js's own canvas is identified by watching one sample that is known to
// happen. Nothing in this file asserts on a readback size, which would just restate a constant.
const contextProto = Object.getPrototypeOf(dom.video.getContext('2d'));
const realGetImageData = contextProto.getImageData;
let readbacks = [];
let failingCanvas = null;
contextProto.getImageData = function (...args) {
  readbacks.push(this.canvas);
  if (failingCanvas && this.canvas === failingCanvas) throw new Error('readback refused');
  return realGetImageData.apply(this, args);
};

// Paints a grey frame: fine deterministic texture everywhere, optionally shifted (the camera
// moving), optionally brightened as a whole (auto-exposure), optionally with one bright block in
// it (something in front of the camera).
//
// Texture matters. A flat frame would make the panning test vacuous - there would be nothing for
// a pan to change - and it is also what makes a *static* frame diff to nothing, since the same
// noise sampled twice at the same offsets is the same noise.
const backgrounds = new Map();
function background(w, h, shift, bright) {
  const key = `${w}x${h}:${shift}:${bright}`;
  let cached = backgrounds.get(key);
  if (cached) return cached;
  cached = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = Math.sin(((x + shift) * 12.9898 + y * 78.233) * 43758.5453);
      const grey = Math.max(0, Math.min(255, 60 + (n - Math.floor(n)) * 90 + bright));
      const i = (y * w + x) * 4;
      cached[i] = grey;
      cached[i + 1] = grey;
      cached[i + 2] = grey;
      cached[i + 3] = 255;
    }
  }
  backgrounds.set(key, cached);
  return cached;
}

function paintFrame(canvas, { shift = 0, bright = 0, mover = null } = {}) {
  const { width: w, height: h, pixels } = canvas;
  // The background is cached per (shift, brightness). The loop tests repaint hundreds of times,
  // and a per-pixel Math.sin over a 640x360 frame made the *painting* the slowest thing in this
  // file by a wide margin - 70 seconds for one test.
  pixels.set(background(w, h, shift, bright));
  if (!mover) return;
  const grey = Math.max(0, Math.min(255, 220 + bright));
  for (let y = mover.y; y < mover.y + mover.h; y++) {
    for (let x = mover.x; x < mover.x + mover.w; x++) {
      const i = (y * w + x) * 4;
      pixels[i] = grey;
      pixels[i + 1] = grey;
      pixels[i + 2] = grey;
    }
  }
}

// A block big enough and bright enough that the mechanism is what is being measured. `at` is its
// left edge; everything here keeps it in the right half of the frame, clear of the tracks the
// loop tests install on the left.
const mover = (at) => ({ x: at, y: 120, w: 70, h: 120 });
const MOVER_HOME = 330;

// Two adjacent cycles 50 ms apart. Returns the second sample's record - the first can never hint,
// since there is nothing yet to compare against. Both frames are spelled out by the caller: a
// helper that painted the "before" itself is how the first draft of the auto-exposure test ended
// up measuring a block *vanishing* rather than a brightness step, and passing for it.
function twoFrames(first, second, { boxes = [], trackBoxes = [] } = {}) {
  paintFrame(dom.video, first);
  motion.sampleFrameMotion(dom.video, dom.now, { boxes, trackBoxes });
  dom.advance(SEARCHING_MS);
  paintFrame(dom.video, second);
  return motion.sampleFrameMotion(dom.video, dom.now, { boxes, trackBoxes });
}

// The two frames every "does this hint" test wants: a block, then the same block moved.
const STILL = { mover: mover(MOVER_HOME) };
const MOVED = { mover: mover(MOVER_HOME + 60) };

beforeEach(() => {
  motion.resetFrameMotion();
  readbacks = [];
  failingCanvas = null;
  dom.element('debug').textContent = '';
  dom.element('crosshair').classes.clear();
  // Give the camera its backing store back. One test below discards it, as iOS does under memory
  // pressure, and `dom.video` is shared by every test in the file - a discarded canvas paints
  // nothing, so leaving it discarded silently rigs every later test into measuring a blank frame.
  // Which is exactly what happened: six tests failed for that and not for anything they assert.
  // Assigning the same width still re-runs the resize, which is what clears the flag.
  dom.video.width = 640;
  dom.video.height = 360;
});

// ---- what the differencing claims ----

test('the first look can never hint, and the next one can', () => {
  // There is nothing to difference a single frame against, so a cold start must be silent however
  // much is moving - otherwise every entry into the game screen would hint once for free.
  paintFrame(dom.video, { mover: mover(MOVER_HOME) });
  const first = motion.sampleFrameMotion(dom.video, dom.now, {});
  assert.equal(first.hint, false);
  assert.equal(motion.frameMotionHint(dom.now), false);

  dom.advance(SEARCHING_MS);
  paintFrame(dom.video, { mover: mover(MOVER_HOME + 60) });
  assert.equal(motion.sampleFrameMotion(dom.video, dom.now, {}).hint, true);
  assert.equal(motion.frameMotionHint(dom.now), true);
});

test('a mover a detector box accounts for is not a hint', () => {
  // The question is "is something moving where we have *not* found anybody". A person the detector
  // has is movement already accounted for, and hinting on it would pin the fast tier for as long
  // as anyone was on screen moving.
  const covering = [{ x: MOVER_HOME - 10, y: 100, w: 150, h: 180 }];
  const uncovered = twoFrames(STILL, MOVED, {});
  assert.equal(uncovered.hint, true, 'the same movement with no box must hint, or this proves nothing');

  motion.resetFrameMotion();
  const covered = twoFrames(STILL, MOVED, { boxes: covering });
  assert.equal(covered.hint, false);
  assert.ok(covered.moving > 0, 'the movement was still seen - it was attributed, not missed');
});

test('a mover a live track accounts for is not a hint either', () => {
  // A coasting person has no box this cycle but is very much known - that is the 'lost' tier's
  // business, not movement's. Passed separately from the boxes because they come from different
  // places in the loop (the detector's answer, and the tracks' projected positions).
  const result = twoFrames(STILL, MOVED, { trackBoxes: [{ x: MOVER_HOME - 10, y: 100, w: 150, h: 180 }] });
  assert.equal(result.hint, false);
  assert.ok(result.moving > 0);
});

// ---- camera shake, which is what makes naive differencing useless ----

test('the camera panning is not movement in front of the camera, however many pixels changed', () => {
  // The headline guard. A hand-held phone pans constantly and a pan moves every textured pixel in
  // the frame, so a naive diff lights up everywhere. This holds the reject down from the image
  // alone - there is no gyroscope in this build by design.
  const panned = twoFrames({}, { shift: 7 });
  assert.equal(panned.hint, false);
  assert.equal(panned.reason, 'global-motion');
  assert.equal(motion.frameMotionHint(dom.now), false);

  // ...and it is the *extent* that rejects it, not a lack of change: the pan changed strictly more
  // of the frame than the mover that does hint.
  motion.resetFrameMotion();
  const moved = twoFrames(STILL, MOVED);
  assert.equal(moved.hint, true);
  assert.ok(panned.moving > moved.moving, `pan lit ${panned.moving} cells, the mover ${moved.moving}`);
});

test('a pan carrying a real mover with it still learns nothing, rather than guessing', () => {
  // A frame you cannot register is a frame you cannot learn from. The safe answer is silence, not
  // a hint that happens to be right for the wrong reason.
  const result = twoFrames(STILL, { shift: 7, mover: mover(MOVER_HOME + 60) });
  assert.equal(result.hint, false);
  assert.equal(result.reason, 'global-motion');
});

test('auto-exposure brightening the whole frame is not movement', () => {
  // The other way a whole frame changes at once. Each pixel is compared against its own frame's
  // mean, so a uniform step cancels - without that, every exposure change would hint.
  const result = twoFrames({}, { bright: 20 });
  assert.equal(result.hint, false);
  assert.equal(motion.frameMotionHint(dom.now), false);
});

test('a brightening frame still shows a mover moving inside it', () => {
  // The exposure normalisation must not be a blanket mute: it removes the frame-wide component
  // and leaves local change alone.
  const result = twoFrames(STILL, { bright: 20, mover: mover(MOVER_HOME + 60) });
  assert.equal(result.hint, true);
});

test('two frames too far apart are two pictures, not a difference', () => {
  paintFrame(dom.video, { mover: mover(MOVER_HOME) });
  motion.sampleFrameMotion(dom.video, dom.now, {});
  dom.advance(5000);
  paintFrame(dom.video, { mover: mover(MOVER_HOME + 60) });
  const stale = motion.sampleFrameMotion(dom.video, dom.now, {});
  assert.equal(stale.hint, false);
  assert.equal(stale.reason, 'stale-previous');

  // ...and the stale frame is kept, so the very next cycle is usable again rather than needing
  // another cold start.
  dom.advance(SEARCHING_MS);
  paintFrame(dom.video, { mover: mover(MOVER_HOME + 120) });
  assert.equal(motion.sampleFrameMotion(dom.video, dom.now, {}).hint, true);
});

// ---- the cost bound ----

test('a hint expires, and movement may not ask again until the refractory is up', () => {
  // This is the whole reason a moving curtain cannot pin the phone at the fast tier. Without the
  // refractory, anything that keeps moving in an uncovered part of the frame holds the fast
  // cadence and the relaxed pose interval open for the rest of the round.
  const hinted = twoFrames(STILL, MOVED);
  assert.equal(hinted.hint, true);
  const hintedAt = dom.now;

  // The hold ends on its own.
  assert.equal(motion.frameMotionHint(hintedAt + 250), true);
  assert.equal(motion.frameMotionHint(hintedAt + 2000), false);

  // And once it has, the same movement is refused for a while rather than re-arming at once.
  dom.advance(400);
  paintFrame(dom.video, { mover: mover(MOVER_HOME + 120) });
  const refused = motion.sampleFrameMotion(dom.video, dom.now, {});
  assert.equal(refused.hint, false);
  assert.equal(refused.reason, 'suppressed');

  // ...and it does come back, so one hint is not the only one a round ever gets.
  dom.advance(4000);
  paintFrame(dom.video, { mover: mover(MOVER_HOME) });
  motion.sampleFrameMotion(dom.video, dom.now, {});
  dom.advance(SEARCHING_MS);
  paintFrame(dom.video, { mover: mover(MOVER_HOME + 60) });
  assert.equal(motion.sampleFrameMotion(dom.video, dom.now, {}).hint, true);
});

test('while a hint or its refractory is running there is nothing worth sampling for', () => {
  // What the loop consults before paying for a readback. A hint that is already holding cannot be
  // extended past its refractory, so a second look is a readback spent on a decision that is
  // already made.
  assert.equal(motion.frameMotionWorthSampling(dom.now), true);
  const hinted = twoFrames(STILL, MOVED);
  assert.equal(hinted.hint, true);
  assert.equal(motion.frameMotionWorthSampling(dom.now), false, 'not while the hold runs');
  assert.equal(motion.frameMotionWorthSampling(dom.now + 400), false, 'not while the refractory runs');
  assert.equal(motion.frameMotionWorthSampling(dom.now + 4000), true, 'and yes once it is up');
});

// ---- degrading to nothing ----

test('a frame the device threw away is not read as the whole world moving', () => {
  // iOS discards canvas backing stores under memory pressure: the object lives, the pixels read
  // back transparent black. Nothing can tell that from a very dark photo except by looking at
  // alpha, and a diff against it would be a frame-wide change.
  paintFrame(dom.video, { mover: mover(MOVER_HOME) });
  motion.sampleFrameMotion(dom.video, dom.now, {});
  dom.advance(SEARCHING_MS);
  dom.video.discard();
  const lost = motion.sampleFrameMotion(dom.video, dom.now, {});
  assert.equal(lost.hint, false);
  assert.equal(lost.reason, 'unusable-frame');

  // ...and the unusable frame was not stored, so the good frame before it is still the one the
  // next cycle differences against - a lost frame costs no information beyond its own cycle.
  dom.video.width = 640; // the camera comes back
  dom.advance(SEARCHING_MS);
  paintFrame(dom.video, { mover: mover(MOVER_HOME + 60) });
  assert.equal(motion.sampleFrameMotion(dom.video, dom.now, {}).hint, true);
});

test('a readback that throws turns the whole thing off instead of throwing every cycle', () => {
  // Whatever makes getImageData throw does not heal, so the module must stop asking - and must
  // never propagate, since it sits on the detection path.
  paintFrame(dom.video, { mover: mover(MOVER_HOME) });
  motion.sampleFrameMotion(dom.video, dom.now, {});
  failingCanvas = readbacks.at(-1);
  assert.ok(failingCanvas && failingCanvas !== dom.video, 'the module reads back its own canvas');

  dom.advance(SEARCHING_MS);
  paintFrame(dom.video, { mover: mover(MOVER_HOME + 60) });
  const broken = motion.sampleFrameMotion(dom.video, dom.now, {});
  assert.equal(broken.hint, false);
  assert.equal(motion.frameMotionWorthSampling(dom.now), false, 'and it stops being worth sampling');

  // No further readback is even attempted, so the throw is paid for once and not per cycle.
  const after = readbacks.length;
  dom.advance(SEARCHING_MS);
  assert.equal(motion.sampleFrameMotion(dom.video, dom.now, {}).reason, 'disabled');
  assert.equal(readbacks.length, after);
});

test('a camera with no dimensions yet is silent, not an exception', () => {
  const blank = { videoWidth: 0, videoHeight: 0 };
  const result = motion.sampleFrameMotion(blank, dom.now, {});
  assert.equal(result.hint, false);
  assert.equal(result.reason, 'unusable-frame');
});

// ---- what the detection loop does about it ----

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

function countingPose() {
  const pose = {
    calls: 0,
    detectForVideo() {
      pose.calls++;
      return { landmarks: [], worldLandmarks: [] };
    },
  };
  return pose;
}

// A track on the LEFT of the frame, well clear of where the movers are painted, so a track's own
// box never accounts for the movement a test is arranging.
function namedTrack({ seenAt, missedFrames = 0, playerId = TARGET_ID } = {}) {
  const box = { x: 20, y: 80, w: 60, h: 200 };
  return {
    id: 1,
    box,
    measuredCenter: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
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

// `enrolled` fills both galleries, because rosterCandidateCount() < 2 stops pose running at all -
// a pose test that forgets it measures zero and looks like it passed.
function arrangeRound({ detector = countingDetector(), pose = null, tracks = [], enrolled = false } = {}) {
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
    lastGameDetectAt: now,
    lastGamePoseDetectAt: now,
    countdownEndsAt: null,
    postProcessingScan: false,
    recordingScan: false,
    bannerOverride: null,
  });
  return { detector, pose };
}

// `ms` of wall clock as 1 ms animation frames, with the block repainted at a position that steps
// every 25 ms - so whichever cycles the loop chooses to sample on, the two frames it differences
// are always a real step apart. Tracks are re-pinned every frame for the reason
// detect-cadence.test.js pins them: refreshGameDetection replaces state.tracks with the tracker's
// output, which with a detector that returns nothing is empty, and the tier would silently
// collapse to the settled one.
// Returns the set of tiers the loop actually detected in, because that is the honest way to ask
// which tier a run reached. Reading detectTier() once after the run instead asks what the tier
// happened to be at one arbitrary instant - and since a hint holds for a few hundred ms and is
// then in its refractory for well over a second, that instant is usually a quiet one. Four of
// these tests passed or failed on where the run stopped before this was recorded per cycle.
function runFor(ms, tracks = [], { moving = true } = {}) {
  const tiers = new Set();
  let painted = null;
  for (let i = 0; i < ms; i++) {
    const step = moving ? (Math.floor(dom.now / 25) * 35) % 210 : 0;
    // Repainted only when the block has actually stepped: the camera does not change between
    // animation frames here, so repainting every millisecond was 25x the work for no difference.
    if (step !== painted) {
      paintFrame(dom.video, { mover: mover(MOVER_HOME + step) });
      painted = step;
    }
    state.tracks = tracks.map((track) => ({ ...track, lastSeen: dom.now, lastUpdated: dom.now }));
    dom.video.currentTime += 0.001;
    // The tier is read *before* the frame, which is where loop() reads it, and recorded only if
    // that frame went on to detect. Reading it afterwards instead asks the wrong question: a
    // detection replaces state.tracks with the tracker's own output, which with a detector that
    // returns no boxes is empty - so the pinned track is gone by then and every tier that depends
    // on one reads as absent. That is what the first version of this did, and it made the two
    // ordering tests below disagree with a loop that was behaving correctly.
    const tier = game.detectTier(dom.now);
    const detectedAt = state.lastGameDetectAt;
    game.loop();
    if (state.lastGameDetectAt !== detectedAt) tiers.add(tier);
    dom.advance(1);
  }
  return tiers;
}

test('movement nobody has accounted for is its own tier', () => {
  // An empty screen is the settled tier - that is what detect-cadence.test.js pins. Something
  // moving out there that no box and no track covers is the one state that speaks for a person the
  // object detector never found at all, so it has to be able to raise the tier on its own.
  arrangeRound();
  assert.ok(runFor(400, []).has('motion'));

  // ...and the same empty screen with nothing moving in it never leaves the settled tier, so the
  // tier above is the movement and not merely the emptiness.
  motion.resetFrameMotion();
  arrangeRound();
  assert.deepEqual([...runFor(400, [], { moving: false })], [null]);
});

test('a coasting person still outranks movement', () => {
  // 'lost' is a person the detector had and dropped, which is the case the player actually sees -
  // the box drifting off someone standing in front of them. It must keep winning outright, so a
  // run with both a coasting track and movement in it never reports movement.
  arrangeRound();
  assert.deepEqual([...runFor(400, [namedTrack({ seenAt: dom.now, missedFrames: 2 })])], ['lost']);
});

test('movement outranks a track that merely has no name yet', () => {
  // 'acquiring' is a track that exists and is waiting to be named, and more detection will not
  // name it any sooner: naming is throttled by RECHECK_MS and by re-identification, not by the
  // detection rate. Movement is somebody not found at all, and detection is exactly what finds
  // them - so when both are true, movement is what the tier should say.
  const unnamed = { ...namedTrack({ seenAt: dom.now }), playerId: null, name: null };
  arrangeRound();
  assert.ok(runFor(400, [unnamed]).has('motion'));

  // Without the movement the same track reports 'acquiring' and nothing else, which is what makes
  // the line above an ordering and not just a coincidence.
  motion.resetFrameMotion();
  arrangeRound();
  assert.deepEqual([...runFor(400, [unnamed], { moving: false })], ['acquiring']);
});

test('the movement tier actually detects faster, measured end to end', () => {
  // The point of the tier rather than the name of it. An empty screen with something moving in it
  // detects at the searching rate; an empty still screen detects at the settled rate.
  const moving = arrangeRound();
  runFor(1000, []);
  const movingCalls = moving.detector.calls;

  motion.resetFrameMotion();
  const still = arrangeRound();
  runFor(1000, [], { moving: false });
  const stillCalls = still.detector.calls;

  assert.ok(movingCalls > stillCalls, `moving ran ${movingCalls} detections, still ran ${stillCalls}`);
  // The refractory means movement does not hold the fast tier for the whole second, so this is
  // bounded on both sides rather than pinned at 20: faster than settled, and never faster than
  // the searching interval allows.
  assert.ok(stillCalls > 1000 / SETTLED_MS - 2, `settled floor: ${stillCalls}`);
  assert.ok(movingCalls <= 1000 / SEARCHING_MS + 1, `never faster than the searching interval: ${movingCalls}`);
});

test('movement buys a pose pass, which is what finds a person the object detector missed', () => {
  // detector.js's pose fallback is the one thing in the app that recovers "a pose nowhere near any
  // surviving object box". Relaxing its interval is most of what a hint is for, so a hint that did
  // not do this would be a hint that bought nothing.
  const moving = arrangeRound({ pose: countingPose(), enrolled: true });
  runFor(1000, []);
  const movingPoses = moving.pose.calls;

  motion.resetFrameMotion();
  const still = arrangeRound({ pose: countingPose(), enrolled: true });
  runFor(1000, [], { moving: false });

  assert.ok(movingPoses > still.pose.calls, `moving ran ${movingPoses} pose passes, still ran ${still.pose.calls}`);
});

test('the busiest tier pays nothing for movement at all', () => {
  // The adaptivity claim, counted rather than argued. A coasting track already has the fast
  // cadence and the relaxed pose interval, so there is no escalation left for movement to ask for
  // - and that is the state where the thread is most contended and the FIRE button most at risk.
  // So no readback is taken there. Counted against the same run in the settled tier, which does
  // sample, so this cannot pass by nothing happening at all.
  const motionCanvas = (() => {
    paintFrame(dom.video, { mover: mover(MOVER_HOME) });
    motion.sampleFrameMotion(dom.video, dom.now, {});
    return readbacks.at(-1);
  })();
  motion.resetFrameMotion();

  const countOwn = () => readbacks.filter((canvas) => canvas === motionCanvas).length;

  arrangeRound();
  readbacks = [];
  runFor(300, []);
  const settledReadbacks = countOwn();

  motion.resetFrameMotion();
  arrangeRound();
  readbacks = [];
  runFor(300, [namedTrack({ seenAt: dom.now, missedFrames: 2 })]);
  const lostReadbacks = countOwn();

  assert.ok(settledReadbacks > 0, 'the settled tier must be sampling, or this proves nothing');
  assert.equal(lostReadbacks, 0);
});

test('with differencing unavailable the cadence is exactly what it was before', () => {
  // The degradation promise. A phone whose readback refuses must behave as though this module had
  // never been written, not fall into some third behaviour.
  paintFrame(dom.video, { mover: mover(MOVER_HOME) });
  motion.sampleFrameMotion(dom.video, dom.now, {});
  failingCanvas = readbacks.at(-1);
  motion.resetFrameMotion();

  const broken = arrangeRound();
  runFor(1000, []);
  const brokenCalls = broken.detector.calls;

  failingCanvas = null;
  motion.resetFrameMotion();
  const still = arrangeRound();
  runFor(1000, [], { moving: false });

  assert.equal(brokenCalls, still.detector.calls, 'a broken readback must detect at the settled rate');
  assert.equal(game.detectTier(dom.now), null);
});

test('a movement hint names nobody, draws nobody and cannot be shot', () => {
  // The safety claim, and the reason nothing here is fed to the tracker as a box. A hint may
  // justify *looking* somewhere; it must never put a person on the screen or under the crosshair.
  // identify.js owns naming and is untouched by any of this.
  arrangeRound();
  assert.ok(runFor(400, []).has('motion'), 'the hint must have fired, or this proves nothing');

  assert.deepEqual(state.boxes, [], 'movement is not a box');
  assert.deepEqual(state.tracks, [], 'movement is not a track');
  assert.equal(dom.element('crosshair').classes.has('on-target'), false);

  let posted = 0;
  globalThis.fetch = async () => {
    posted++;
    return { ok: true, text: async () => '' };
  };
  game.fire();
  assert.equal(posted, 0, 'there is nothing to shoot');
});
