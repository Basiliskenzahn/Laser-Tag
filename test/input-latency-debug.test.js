// The input readout wired into the real `?debug` overlay (frontend/public/screens/game.js).
//
// test/input-latency.test.js tests the formatting and the guards in isolation; this file proves
// the numbers on the phone screen are the ones the brief asked for - that the tap figure really
// is measured from the originating event's timeStamp rather than from the handler, that the shot
// figure really spans fire() rather than being a constant zero, and that the block figure is a
// real frame gap.
//
// `?debug` is ON here, which is why it is a separate file: ESM evaluates env.js once per process
// and env.js reads location.search at module scope. The without-?debug half, including the proof
// that none of this runs then, lives in test/shot-latency.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakeDom } from './helpers/fake-dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);

const dom = installFakeDom({ videoWidth: 640, videoHeight: 360 });
// Before env.js is evaluated, which is what the import below does.
globalThis.location = { search: '?debug', href: 'https://phone.test/?debug' };
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
Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true, configurable: true });
// debugOverlay() moves the overlay to <body> and positions it there; fake-dom's elements carry no
// style object because nothing the scan screen does needs one.
dom.element('debug').style = {};

const game = await import('../frontend/public/screens/game.js');
const { state } = await import('../frontend/public/state.js');
const { DEBUG } = await import('../frontend/public/env.js');

const SELF_ID = 'self-uuid-0001';
const TARGET_ID = 'target-uuid-0002';

test('this file really is running with ?debug', () => {
  // Every assertion below is vacuous if DEBUG is somehow off.
  assert.equal(DEBUG, true);
});

function arrangeRound({ tracks = [] } = {}) {
  globalThis.fetch = async () => ({ ok: true, text: async () => '' });
  dom.video.readyState = 2;
  dom.video.currentTime ??= 0;
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
    detector: { detectForVideo: () => ({ detections: [] }) },
    poseDetector: null,
    embedder: null,
    reid: null,
    tracks,
    boxes: [],
    lastShotAt: 0,
    lastGameDetectAt: dom.now,
    lastGamePoseDetectAt: 0,
    countdownEndsAt: null,
    postProcessingScan: false,
    recordingScan: false,
    bannerOverride: null,
  });
}

// A track dead centre of the frame that the appearance provider will name and the game will let
// you shoot - so a shot actually resolves and gets measured.
function centredTarget(seenAt) {
  return {
    id: 1,
    box: { x: 320 - 30, y: 180 - 100, w: 60, h: 200 },
    measuredCenter: { x: 320, y: 180 },
    vx: 0,
    vy: 0,
    lastSeen: seenAt,
    lastUpdated: seenAt,
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

function frame() {
  dom.video.currentTime += 0.033;
  game.loop();
}

// The one line out of the overlay this file is about.
function inputLine() {
  return (
    dom
      .element('debug')
      .textContent.split('\n')
      .find((line) => line.startsWith('Input')) ?? ''
  );
}

// ---- the longest blocking chunk ----
//
// First, deliberately: with no shot recorded yet the line is the block figure alone, so it can be
// asserted exactly rather than through a pattern.

test('the longest blocking chunk is the frame gap, and only a plausible one', () => {
  arrangeRound();
  // A gap this long is the tab having been hidden, not the main thread blocking, and must be
  // discarded - it would otherwise sit in the window as the worst case for seconds.
  dom.advance(5000);
  frame();
  assert.equal(inputLine(), '', 'a 5 s gap was recorded as a blocking chunk');

  // 96 ms is a plausible one: roughly a pose inference on a mid-range phone.
  dom.advance(96);
  frame();
  assert.equal(inputLine(), 'Input block 96');
});

// ---- the delivery wait ----

test('the tap figure is measured from the event timestamp, not from the handler', () => {
  // A pointerdown the browser created 120 ms before our handler got to run: the tap spent that
  // long queued behind whatever was on the main thread. Reading the clock inside fire() would
  // report 0, which is the whole reason the timeStamp is passed in.
  arrangeRound({ tracks: [centredTarget(dom.now)] });
  const createdAt = dom.now - 120;

  game.fire(createdAt);
  frame();

  assert.match(inputLine(), /^Input tap 120\/120 /);
});

test('the shot figure spans fire(), so work put back on the shot path would show', () => {
  // The clock is advanced from inside fire() - restartAnimation() is called between entering and
  // resolving the shot - which is the only way to prove the second measurement is a span and not
  // a hard-coded zero.
  arrangeRound({ tracks: [centredTarget(dom.now)] });
  const crosshair = dom.element('crosshair');
  const realAdd = crosshair.classList.add;
  crosshair.classList.add = (name) => {
    dom.advance(45);
    return realAdd(name);
  };
  try {
    game.fire(dom.now - 7);
  } finally {
    crosshair.classList.add = realAdd;
  }
  frame();

  // Two shots now: the tap figures are the mean and worst of 7 and 120, and the shot figures the
  // mean and worst of this 45 and the previous shot's 0.
  assert.match(inputLine(), /^Input tap 64\/120 shot 23\/45 n2\b/);
});

test('a keyboard shot with no timestamp still reports what fire() cost', () => {
  arrangeRound({ tracks: [centredTarget(dom.now)] });
  state.lastShotAt = 0;

  game.fire(null);
  frame();

  // Three shots now, the third with no usable tap - so the tap figures still come from the two
  // that had one, and `n3` says what they are a mean over.
  assert.match(inputLine(), /^Input tap 64\/120 shot 15\/45 n3\b/);
});

test('an ordinary shot now costs nothing measurable, which is the point of the change', () => {
  // With the forced detection off the shot path, fire() resolves and sends inside the same
  // millisecond. If a refresh were put back, this is the figure that would move.
  arrangeRound({ tracks: [centredTarget(dom.now)] });
  state.lastShotAt = 0;
  state.lastGameDetectAt = dom.now - 400; // stale enough that the old path would have refreshed

  game.fire(dom.now - 3);
  frame();

  assert.match(inputLine(), / shot 11\/45 n4\b/);
});

// ---- the overlay itself ----

test('the input line sits in the overlay alongside the detection lines', () => {
  arrangeRound({ tracks: [centredTarget(dom.now)] });
  frame();
  const text = dom.element('debug').textContent;

  assert.ok(text.includes('fps'), 'the overlay is not rendering at all');
  assert.ok(
    text.split('\n').some((line) => line.startsWith('Input tap ')),
    `no Input line in the overlay:\n${text}`,
  );
  // debugOverlay() relocates the element into <body> so it can be read on the scan screen too;
  // the without-?debug file asserts the mirror of this.
  assert.ok(document.body.children.length > 0, 'the overlay was never relocated');
});
