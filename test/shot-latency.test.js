// The shot path, driven for real: what fire() costs and what it resolves the shot against.
//
// The field complaint was "there is some kind of lag if i press the button since other stuff needs
// to be processed as well". fire() used to force a full synchronous detection - object detector,
// plus the pose model once two players were enrolled - before it resolved the shot, on the one path
// in the app where the player is waiting. These tests hold that off the shot path, and hold down
// the thing that makes removing it safe: the shot resolves against the same projected box the
// crosshair was set from.
//
// Real here: screens/game.js, detector.js's box plumbing, identify.js's tracker, roster.js,
// target.js and every threshold. Faked: the camera's pixels, the object detector's answer and the
// clock.
//
// `?debug` is OFF in this file (installFakeDom leaves location.search empty and ESM evaluates
// env.js once per process), which makes it also the place to prove the debug overlay costs nothing
// when it is absent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakeDom } from './helpers/fake-dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);

const dom = installFakeDom({ videoWidth: 640, videoHeight: 360 });

// fitCanvas() reads window.devicePixelRatio and the overlay's layout size, and draw() uses a few
// context methods the scan screen never needed. Patched here rather than in fake-dom.js so the
// scan tests that share that helper are not touched.
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
const { DEBUG } = await import('../frontend/public/env.js');

const SELF_ID = 'self-uuid-0001';
const TARGET_ID = 'target-uuid-0002';
const FRAME_W = 640;
const FRAME_H = 360;

// A fake object detector that counts how many times it was asked. Counting the *detector* rather
// than refreshGameDetection() is the point: it is the synchronous inference that blocks the main
// thread, and it is what a forced refresh inside the shot would pay for.
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

// A track the appearance provider will name and the game will let you shoot: identified long
// enough ago to have cleared the 350 ms colour lock, with colour parts over their minimums.
function shootableTrack({ x, y, w = 60, h = 200, vx = 0, vy = 0, seenAt, updatedAt = seenAt }) {
  return {
    id: 1,
    box: { x, y, w, h },
    measuredCenter: { x: x + w / 2, y: y + h / 2 },
    vx,
    vy,
    lastSeen: seenAt,
    lastUpdated: updatedAt,
    playerId: TARGET_ID,
    name: 'Target',
    identifiedAt: seenAt - 2000,
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
  };
}

// Centre a box of this size on the crosshair, which is the centre of the video frame. The body
// hitbox is narrower and shorter than the detector box (detector.js), so centring the detector
// box is what puts the body hitbox under the crosshair.
function centredAt(cx, cy, { w = 60, h = 200 } = {}) {
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

const hits = [];

function arrangeRound({ detector = countingDetector(), tracks = [], detectedAt = null } = {}) {
  hits.length = 0;
  globalThis.fetch = async (url, options) => {
    hits.push(JSON.parse(options.body));
    return { ok: true, text: async () => '' };
  };
  Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true, configurable: true });

  dom.video.readyState = 2;
  // `currentTime` is deliberately never reset: loop() only detects on a video frame it has not
  // seen, and rewinding it between tests would silently stop the loop detecting at all.
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
      { id: SELF_ID, name: 'Me', gallery: [] },
      { id: TARGET_ID, name: 'Target', gallery: [] },
    ],
    localGallery: [],
    detector,
    poseDetector: null,
    embedder: null,
    reid: null,
    tracks,
    boxes: [],
    lastShotAt: 0,
    lastGameDetectAt: detectedAt ?? now,
    lastGamePoseDetectAt: 0,
    countdownEndsAt: null,
    postProcessingScan: false,
    recordingScan: false,
    bannerOverride: null,
  });
  return { detector };
}

// One turn of the frame loop, with a new video frame so the loop considers detecting. loop()
// queues the next frame on the fake requestAnimationFrame; nothing flushes that queue here, so
// each call is exactly one frame and the clock only moves when a test says so.
function frame() {
  dom.video.currentTime += 0.033;
  game.loop();
}

beforeEach(() => {
  dom.element('debug').textContent = '';
  dom.element('crosshair').classes.clear();
});

// ---- the forced detection is off the shot path ----

test('firing does not run a detection, however stale the last one is', () => {
  // The old shot path forced a fresh detection whenever the last one was more than 90 ms old -
  // and the detection interval is 120 ms at its fastest, so that fired on a large share of every
  // shot. 400 ms stale here is well past any threshold it could have used.
  const { detector } = arrangeRound({
    detector: countingDetector(),
    detectedAt: dom.now - 400,
    tracks: [shootableTrack({ ...centredAt(FRAME_W / 2, FRAME_H / 2), seenAt: dom.now })],
  });

  game.fire(dom.now);

  assert.equal(detector.calls, 0, 'the shot ran an inference');
  // And the shot still landed - removing the refresh must not cost the hit.
  assert.deepEqual(hits, [{ room: 'demo', shooterId: SELF_ID, targetId: TARGET_ID, zone: 'body' }]);
});

test('firing does not run the pose model even with two players enrolled', () => {
  // The forced refresh asked for the pose landmarker specifically once two galleries existed,
  // which is the ordinary two-player case and the most expensive model in the pipeline.
  const pose = countingDetector();
  const { detector } = arrangeRound({
    detector: countingDetector(),
    detectedAt: dom.now - 400,
    tracks: [shootableTrack({ ...centredAt(FRAME_W / 2, FRAME_H / 2), seenAt: dom.now })],
  });
  state.poseDetector = pose;
  state.roster = [
    { id: SELF_ID, name: 'Me', gallery: [{}] },
    { id: TARGET_ID, name: 'Target', gallery: [{}] },
  ];

  game.fire(dom.now);

  assert.equal(pose.calls, 0, 'the shot ran the pose model');
  assert.equal(detector.calls, 0);
  assert.equal(hits.length, 1);
});

// ---- what makes that safe: the shot uses the projected box ----

test('the shot follows a moving target along its velocity, not its last detected box', () => {
  // The box was measured 200 ms ago, 50 px left of centre, moving right at 250 px/s. Where the
  // person is *now* is the middle of the screen, and that is what a shot must hit - computed from
  // work already paid for, which is why no fresh detection is needed.
  const box = centredAt(FRAME_W / 2 - 50, FRAME_H / 2);
  arrangeRound({ tracks: [shootableTrack({ ...box, vx: 250, vy: 0, seenAt: dom.now - 200 })] });

  game.fire(dom.now);

  assert.equal(hits.length, 1, 'the projected box was not under the crosshair');
  assert.equal(hits[0].zone, 'body');
});

test('a target whose projection has carried it off the crosshair is a miss', () => {
  // The mirror of the test above, and the one that proves it is the projection being used rather
  // than a box that happens to be wide enough: raw box dead centre, velocity taking it away.
  const box = centredAt(FRAME_W / 2, FRAME_H / 2);
  arrangeRound({ tracks: [shootableTrack({ ...box, vx: 400, vy: 0, seenAt: dom.now - 200 })] });

  game.fire(dom.now);

  assert.equal(hits.length, 0, 'the shot resolved against the raw box');
});

test('the shot agrees with the crosshair the player aimed with', () => {
  // The guarantee the removed refresh was breaking. drawGame() sets `on-target` from the same
  // projected boxes, one frame before the tap; a detection forced inside fire() could move or
  // lose that box afterwards, so the player would tap on a red crosshair and miss.
  const box = centredAt(FRAME_W / 2 - 40, FRAME_H / 2);
  arrangeRound({ tracks: [shootableTrack({ ...box, vx: 250, vy: 0, seenAt: dom.now - 160 })] });

  frame();
  const lockedOn = dom.element('crosshair').classList.contains('on-target');
  game.fire(dom.now);

  assert.equal(lockedOn, true, 'the crosshair never locked on, so this proves nothing');
  assert.equal(hits.length, 1, 'the crosshair said on-target and the shot missed');
});

test('a dead player under the crosshair is still not shootable', () => {
  // Removing the refresh must not loosen who counts as a target.
  arrangeRound({ tracks: [shootableTrack({ ...centredAt(FRAME_W / 2, FRAME_H / 2), seenAt: dom.now })] });
  state.game.players[1].alive = false;

  game.fire(dom.now);

  assert.equal(hits.length, 0);
});

test('a track the detector stopped seeing long ago is not shootable', () => {
  // The liveness window, not the forced refresh, is what retires a departed person - a fresh
  // detection never did, because a track the detector misses keeps its lastSeen and coasts.
  arrangeRound({ tracks: [shootableTrack({ ...centredAt(FRAME_W / 2, FRAME_H / 2), seenAt: dom.now - 900 })] });

  game.fire(dom.now);

  assert.equal(hits.length, 0);
});

// ---- the ?debug instrumentation costs nothing when ?debug is absent ----

test('this file really is running without ?debug', () => {
  // Every assertion below is vacuous if DEBUG is somehow on.
  assert.equal(DEBUG, false);
});

test('no overlay is written and no shot is measured without ?debug', () => {
  arrangeRound({ tracks: [shootableTrack({ ...centredAt(FRAME_W / 2, FRAME_H / 2), seenAt: dom.now })] });
  const debugEl = dom.element('debug');

  for (let i = 0; i < 5; i++) {
    frame();
    dom.advance(16);
    game.fire(dom.now);
    state.lastShotAt = 0;
  }

  assert.equal(debugEl.textContent, '', 'the debug overlay was written to without ?debug');
  // debugOverlay() relocates the element into <body> on its first call, so an empty body is
  // proof it was never called - not merely that the text happened to come out blank.
  assert.equal(document.body.children.length, 0, 'the debug overlay was relocated without ?debug');
  assert.equal(hits.length, 5, 'the shots did not actually fire, so this proves nothing');
});
