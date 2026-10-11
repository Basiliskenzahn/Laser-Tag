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
  assert.equal(hits[0].targetId, TARGET_ID);
  assert.equal(hits[0].zone, 'body');
});

test('a target whose projection has carried it off the crosshair is a miss', () => {
  // The mirror of the test above, and the one that proves it is the projection being used rather
  // than a box that happens to be wide enough: raw box dead centre, velocity taking it away.
  const box = centredAt(FRAME_W / 2, FRAME_H / 2);
  arrangeRound({ tracks: [shootableTrack({ ...box, vx: 400, vy: 0, seenAt: dom.now - 200 })] });

  game.fire(dom.now);

  // Every shot is posted, hit or miss, so the server can count accuracy: a miss is one with no
  // target. Asserting the *target* rather than the number of requests is the whole point - the
  // count would be 1 either way.
  assert.equal(hits.length, 1, 'the shot was not posted at all');
  assert.equal(hits[0].targetId, null, 'the shot resolved against the raw box');
  assert.equal(hits[0].zone, null);
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
  assert.equal(hits.length, 1, 'the shot was not posted at all');
  assert.equal(hits[0].targetId, TARGET_ID, 'the crosshair said on-target and the shot missed');
});

test('a dead player under the crosshair is still not shootable', () => {
  // Removing the refresh must not loosen who counts as a target.
  arrangeRound({ tracks: [shootableTrack({ ...centredAt(FRAME_W / 2, FRAME_H / 2), seenAt: dom.now })] });
  state.game.players[1].alive = false;

  game.fire(dom.now);

  assert.equal(hits[0].targetId, null, 'a dead player was shot');
});

test('a track the detector stopped seeing long ago is not shootable', () => {
  // The liveness window, not the forced refresh, is what retires a departed person - a fresh
  // detection never did, because a track the detector misses keeps its lastSeen and coasts.
  arrangeRound({ tracks: [shootableTrack({ ...centredAt(FRAME_W / 2, FRAME_H / 2), seenAt: dom.now - 900 })] });

  game.fire(dom.now);

  assert.equal(hits[0].targetId, null, 'a track past the liveness window was shot');
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

// ---- who gets shot when two valid targets overlap ----
//
// `targetUnderCrosshair` used to `return` on the first track whose *head* box contained the
// crosshair while letting each later *body* match overwrite the one before it - so a head hit was
// decided by the front of `state.tracks` and a body hit by the back, and with two overlapping
// targets who got shot depended on array order rather than on anything the player can see.
// Tap-anywhere firing (ui-redesign) and the relaxed range gate (identify.js) both make overlapping
// candidates ordinary rather than rare.

const SECOND_ID = 'second-uuid-0003';

// Two players, so a second track can be named someone else.
function arrangeTwoTargets(tracks) {
  const arranged = arrangeRound({ tracks });
  state.game.players.push({ id: SECOND_ID, name: 'Second', hp: 100, alive: true, wins: 0 });
  state.roster.push({ id: SECOND_ID, name: 'Second', gallery: [] });
  return arranged;
}

// The same track shape the rest of this file uses, named as a chosen player.
function trackFor(playerId, box, { id = 1 } = {}) {
  return { ...shootableTrack({ ...box, seenAt: dom.now }), id, playerId, name: playerId };
}

test('with two targets under the crosshair, the nearer one is shot whatever order they are in', () => {
  // Same centre, two very different distances: a 260 px box is a person a few metres away, a 90 px
  // box is someone much further off behind them. Box height is the only distance cue there is, and
  // "you shoot the person in front" is what aiming at a pair means.
  const near = centredAt(FRAME_W / 2, FRAME_H / 2, { w: 78, h: 260 });
  const far = centredAt(FRAME_W / 2, FRAME_H / 2, { w: 27, h: 90 });

  for (const [label, tracks] of [
    ['near first', [trackFor(TARGET_ID, near, { id: 1 }), trackFor(SECOND_ID, far, { id: 2 })]],
    ['far first', [trackFor(SECOND_ID, far, { id: 1 }), trackFor(TARGET_ID, near, { id: 2 })]],
  ]) {
    arrangeTwoTargets(tracks);
    game.fire(dom.now);
    assert.equal(hits.length, 1, `${label}: the shot was not posted`);
    assert.equal(hits[0].targetId, TARGET_ID, `${label}: the shot went to the wrong player`);
  }
});

test('a head on one target beats a body on a nearer one', () => {
  // Head before body is the rule that was always intended, and it used to hold only when the head
  // happened to come first in the array. The nearer box here is deliberately the *body* one, so
  // the two rules disagree and the head has to win.
  //
  // A box 300 px tall centred on the crosshair is hit on the body (detector.js's head box is the
  // top slice, nowhere near the centre). A short box placed so its head slice sits on the
  // crosshair is a head hit.
  const bodyBox = centredAt(FRAME_W / 2, FRAME_H / 2, { w: 90, h: 300 });
  const headShot = { x: FRAME_W / 2 - 20, y: FRAME_H / 2 - 14, w: 40, h: 132 };

  for (const [label, tracks] of [
    ['body first', [trackFor(TARGET_ID, bodyBox, { id: 1 }), trackFor(SECOND_ID, headShot, { id: 2 })]],
    ['head first', [trackFor(SECOND_ID, headShot, { id: 1 }), trackFor(TARGET_ID, bodyBox, { id: 2 })]],
  ]) {
    arrangeTwoTargets(tracks);
    game.fire(dom.now);
    assert.equal(hits.length, 1, `${label}: the shot was not posted`);
    assert.equal(hits[0].zone, 'head', `${label}: a head hit was available and the body was taken`);
    assert.equal(hits[0].targetId, SECOND_ID, `${label}: the head belongs to the other player`);
  }
});

test('the crosshair and the shot pick the same one of two overlapping targets', () => {
  // The guarantee the whole shot path rests on, now that there can be a choice to get wrong:
  // drawGame() highlights `hit?.track` from its own call to targetUnderCrosshair, and fire()
  // resolves the shot from another. Two calls, one rule - so the red box and the hit are the same
  // person, whichever order the tracks are in.
  const near = centredAt(FRAME_W / 2, FRAME_H / 2, { w: 78, h: 260 });
  const far = centredAt(FRAME_W / 2, FRAME_H / 2, { w: 27, h: 90 });
  arrangeTwoTargets([trackFor(SECOND_ID, far, { id: 1 }), trackFor(TARGET_ID, near, { id: 2 })]);

  frame();
  assert.equal(dom.element('crosshair').classList.contains('on-target'), true, 'the crosshair never locked on');
  game.fire(dom.now);
  assert.equal(hits[0].targetId, TARGET_ID);
});

test('an exact tie keeps the earlier track, so the choice does not flicker', () => {
  // Two identically sized boxes on the same spot is a tie, and a tie has to resolve the same way
  // every frame: `betterTarget` is strictly-greater, so neither displaces the other and the answer
  // is stable. A >= there would swap the winner on every call.
  const box = centredAt(FRAME_W / 2, FRAME_H / 2, { w: 60, h: 200 });
  arrangeTwoTargets([trackFor(TARGET_ID, box, { id: 1 }), trackFor(SECOND_ID, box, { id: 2 })]);

  for (let i = 0; i < 4; i++) {
    state.lastShotAt = 0;
    game.fire(dom.now);
  }
  assert.equal(hits.length, 4, 'all four shots should have fired');
  assert.deepEqual(
    hits.map((hit) => hit.targetId),
    Array(4).fill(TARGET_ID),
    'the same tie must resolve the same way every time',
  );
});

// ---- the overlay does not keep stale boxes on a screen nothing draws ----

test('a mode with no painter leaves the overlay blank rather than frozen', () => {
  // `state.mode` goes to 'results' at the end of a round and detection stops, but the camera and
  // the frame loop keep running behind the results panel. Nothing paints the overlay in that mode,
  // so the question is whether the last frame's boxes and names stay on top of the live video.
  // They do not: draw() clears through fitCanvas() before it dispatches, every frame, so "no
  // painter" already means "blank". Pinned here because that clear is load-bearing and nothing
  // about its position in fitCanvas() says so.
  arrangeRound({ tracks: [shootableTrack({ ...centredAt(FRAME_W / 2, FRAME_H / 2), seenAt: dom.now })] });
  const ctx = dom.overlay.getContext('2d');
  let cleared = 0;
  let painted = 0;
  const realClear = ctx.clearRect;
  const realStroke = ctx.strokeRect;
  const realText = ctx.fillText;
  ctx.clearRect = (...args) => (cleared++, realClear?.call(ctx, ...args));
  ctx.strokeRect = (...args) => (painted++, realStroke?.call(ctx, ...args));
  ctx.fillText = (...args) => (painted++, realText?.call(ctx, ...args));
  try {
    frame();
    assert.ok(painted > 0, 'precondition: the game screen really does paint boxes');

    state.mode = 'results';
    cleared = 0;
    painted = 0;
    frame();
    assert.ok(cleared > 0, 'the overlay must be cleared on a frame nothing paints');
    assert.equal(painted, 0, 'and nothing may repaint the old boxes');
  } finally {
    ctx.clearRect = realClear;
    ctx.strokeRect = realStroke;
    ctx.fillText = realText;
    state.mode = 'game';
  }
});

test('the hit bar rides the projected box, not the last detected one', () => {
  // ui-redesign positions a hit bar over the target's head from `track.box`; ours draws every box
  // from `liveBox()`, which projects along the smoothed velocity. The whole shot path is built on
  // "what you see is what you hit", and a bar pinned to the stale box drifts off the person while
  // the box it is supposed to label sits somewhere else.
  //
  // Asserted as movement over time rather than against a computed pixel: the raw box never
  // changes here, so a bar that followed `track.box` could not move at all.
  const box = centredAt(FRAME_W / 2 - 60, FRAME_H / 2);
  arrangeRound({ tracks: [shootableTrack({ ...box, vx: 300, vy: 0, seenAt: dom.now })] });
  game.showHitBar(TARGET_ID, 60, 40);

  frame();
  const first = dom.element('hit-bars').children[0];
  assert.ok(first, 'precondition: a hit bar was created');
  const startedAt = first.style.left;
  assert.ok(startedAt, 'precondition: the bar was positioned at all');

  // Inside the detection interval on purpose: a detection would hand `state.tracks` back to the
  // tracker, which has never seen this hand-made track. So the raw box is untouched and the only
  // thing that has changed between the two frames is how far the projection has carried it.
  dom.advance(40);
  frame();
  assert.notEqual(first.style.left, startedAt, 'the bar did not follow the projection');

  game.clearHitBars();
  assert.deepEqual(dom.element('hit-bars').children, [], 'and the round ending clears them');
});
