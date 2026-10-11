// The camera's two liveness problems (frontend/public/camera.js).
//
// 1. A stream object is not a working camera. `srcObject` stays set when the OS revokes the
//    camera - another app claims it, or the tab was backgrounded long enough - so the guard that
//    skipped `startCamera()` on a non-null `srcObject` let a second trip through the lobby run the
//    whole round on a dead stream. `cameraIsLive()` asks the tracks instead.
//
// 2. Hiding the browser pauses the <video>, and phones often end the track outright; iOS
//    sometimes leaves it `'live'` and never sends another frame. Nothing restarts either by
//    itself, so the picture froze on the last frame until the page was reloaded. `resumeCamera()`
//    plays again and, if frames still do not move, asks for a fresh stream.
//
// Driven through the real camera.js, with every model pre-injected into `state` so that
// prepareCameraAndDetector() creates none of them (the MediaPipe bundle is a stub under Node) and
// the only thing still running for real is the camera half.

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installBrowserStubs } from './helpers/dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);
const dom = installBrowserStubs();

const camera = await import('../frontend/public/camera.js');
const { state } = await import('../frontend/public/state.js');

const video = dom.$('video');

mock.timers.enable({ apis: ['setTimeout'] });

// How long one videoAdvances() window is (camera.js's RESUME_FRAME_TIMEOUT_MS), written out rather
// than imported: deriving it from the constant under test would assert x === x.
const WINDOW_MS = 1200;

// Lets queued microtasks run, so "has this settled yet?" is a fair question between ticks.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Runs the pending awaits and then the next timer, repeatedly - enough turns for the resume to
// walk through play(), both frame windows, and a re-request.
async function run(windows = 3) {
  for (let i = 0; i < windows * 3; i++) {
    await settle();
    mock.timers.tick(WINDOW_MS);
  }
  await settle();
}

// A getUserMedia stand-in. Each stream records whether its tracks were stopped, so "the old stream
// was torn down" is observable rather than inferred.
let granted;
function fakeStream({ readyState = 'live' } = {}) {
  const track = { readyState, stop: () => (track.readyState = 'ended') };
  const stream = { id: `stream-${granted.length}`, track, getVideoTracks: () => [track], getTracks: () => [track] };
  return stream;
}

function installMediaDevices({ fail = null } = {}) {
  granted = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      vibrate() {},
      wakeLock: null,
      mediaDevices: {
        getUserMedia: async (constraints) => {
          if (fail) throw fail;
          const stream = fakeStream();
          granted.push({ stream, constraints });
          return stream;
        },
      },
    },
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  installMediaDevices();
  video.srcObject = null;
  video.currentTime = 0;
  video.plays = 0;
  video.play = async () => {
    video.plays++;
  };
  document.visibilityState = 'visible';
  // Every model is injected through `state`, the way the other front-end tests do it: the real
  // MediaPipe bundle is a stub under Node, and `hadVision` then makes prepareCameraAndDetector
  // create nothing and warm nothing. What is left running for real is the camera half, which is
  // what this file is about.
  Object.assign(state, {
    detector: { detectForVideo: () => ({ detections: [] }) },
    poseDetector: {},
    embedder: {},
    reid: {},
    objectDelegate: 'GPU',
  });
});

// Starts the camera the way the lobby does.
async function openLobby() {
  await camera.prepareCameraAndDetector();
}

// ---- 1. a stream object is not a working camera ----

test('a revoked camera is started again rather than reused', async () => {
  await openLobby();
  assert.equal(granted.length, 1, 'precondition: the first visit asked for a stream');
  assert.equal(video.srcObject, granted[0].stream);

  // The OS hands the camera to another app: every track ends, and srcObject stays exactly as it
  // was. This is the state the old `video.srcObject ? ... : startCamera()` guard called "live".
  for (const track of video.srcObject.getTracks()) track.stop();

  await openLobby();
  assert.equal(granted.length, 2, 'a second visit must not run the round on a dead stream');
  assert.equal(video.srcObject, granted[1].stream, 'and the fresh stream has to be the one in use');
});

test('a camera that is still live is reused, not re-requested', async () => {
  // The control for the test above: the saving the guard exists for is still there, so what the
  // liveness check changed is the dead case only.
  await openLobby();
  await openLobby();
  assert.equal(granted.length, 1, 'a live stream must be reused');
});

test('the stream is asked for at an ideal frame rate, never a minimum', async () => {
  // An unmeetable `min` makes getUserMedia throw OverconstrainedError, i.e. no camera at all.
  await openLobby();
  const { frameRate } = granted[0].constraints.video;
  assert.deepEqual(frameRate, { ideal: 30 });
  assert.equal(granted[0].constraints.video.facingMode.ideal, 'environment');
});

// ---- 2. coming back from the background ----

test('a resumed stream that is delivering frames is played, not replaced', async () => {
  await openLobby();
  const original = video.srcObject;
  video.plays = 0;
  // The decoder is running: currentTime moves on while the resume waits.
  const resume = camera.resumeCamera();
  await settle();
  video.currentTime = 1.5;
  await run();
  await resume;

  assert.ok(video.plays >= 1, 'the paused <video> must be played again');
  assert.equal(video.srcObject, original, 'a working stream must not be torn down');
  assert.equal(granted.length, 1, 'and no new stream may be requested');
  assert.equal(original.track.readyState, 'live');
});

test('a live stream that never delivers another frame is replaced', async () => {
  // The iOS case the fallback exists for: the track still says 'live', and the picture is frozen
  // on the last frame. currentTime is deliberately left alone.
  await openLobby();
  const stuck = video.srcObject;
  const resume = camera.resumeCamera();
  await run();
  await resume;

  assert.equal(stuck.track.readyState, 'ended', 'the stuck stream must be stopped');
  assert.equal(granted.length, 2, 'and a fresh one requested');
  assert.equal(video.srcObject, granted[1].stream);
});

test('one long compile is not enough to write a stream off', async () => {
  // A single missed frame window is not a dead camera: a synchronous model compile (camera.js's
  // warm-up, or the optional models still loading behind the lobby) can starve the decoder for
  // longer than one deadline, and tearing down a working stream on that is a camera restart the
  // player did not need.
  await openLobby();
  const original = video.srcObject;
  const resume = camera.resumeCamera();
  await settle();
  mock.timers.tick(WINDOW_MS); // first window: no frame
  await settle();
  video.currentTime = 2.2; // frames come back during the second
  await run();
  await resume;

  assert.equal(granted.length, 1, 'the stream was replaced after a single stalled window');
  assert.equal(video.srcObject, original);
});

test('many resumes while one is in flight are one resume', async () => {
  // visibilitychange can fire repeatedly, and each re-request is a getUserMedia prompt's worth of
  // work on a phone that has just come back.
  await openLobby();
  const all = [camera.resumeCamera(), camera.resumeCamera(), camera.resumeCamera()];
  assert.equal(all[0], all[1], 'the second caller must get the first resume');
  assert.equal(all[1], all[2]);
  await run();
  await Promise.all(all);
  assert.equal(granted.length, 2, 'three resumes of a stuck stream must request one stream');
});

test('a resume after leaving the lobby does not bring the camera back', async () => {
  await openLobby();
  camera.stopCamera();
  assert.equal(video.srcObject, null, 'precondition: leaving dropped the stream');

  await camera.resumeCamera();
  await run();
  assert.equal(granted.length, 1, 'a phone that left the room must not reacquire the camera');
  assert.equal(video.srcObject, null);
});

test('a resume while the page is hidden does nothing', async () => {
  await openLobby();
  document.visibilityState = 'hidden';
  await camera.resumeCamera();
  await run();
  assert.equal(granted.length, 1);
});

// ---- the two halves must not fight ----

test('a resume while the first play() is still waiting for a frame does not tear the stream down', async () => {
  // The window the guard is actually for, and the one a phone hits. `video.play()` does not
  // resolve until the decoder has something, so a camera that is slow to deliver its first frame
  // leaves `srcObject` set with the start still in flight - and from the outside that is
  // indistinguishable from a stuck resumed stream. Without the wait, the resume stops those
  // tracks and asks for new ones, which rejects the in-flight play() with AbortError; startup.js
  // treats a camera rejection as fatal, so the join screen would show a camera error for a camera
  // that was about to work.
  let firstFrame;
  const decoded = new Promise((resolve) => {
    firstFrame = resolve;
  });
  let plays = 0;
  video.play = async () => {
    plays++;
    if (plays === 1) await decoded;
  };

  const opening = camera.prepareCameraAndDetector();
  await settle();
  await settle();
  const started = video.srcObject;
  assert.ok(started, 'precondition: the stream is installed and play() has not resolved');
  assert.equal(granted.length, 1);

  const resume = camera.resumeCamera();
  await run(); // long enough for both frame windows to expire
  assert.equal(granted.length, 1, 'the resume asked for a stream of its own mid-start');
  assert.equal(started.track.readyState, 'live', 'and stopped the tracks the start was using');
  assert.equal(video.srcObject, started);

  // The camera delivers, the start finishes, and only then may the resume look at the stream -
  // which by now is advancing, so it leaves it alone.
  firstFrame();
  await opening;
  await settle();
  await settle();
  video.currentTime = 4.4;
  await run();
  await resume;
  assert.equal(video.srcObject, started, 'the stream the start installed must survive the resume');
  assert.equal(granted.length, 1);
});

test('a resume during the very first start waits for it instead of replacing its stream', async () => {
  // startup.js's lobby gate rejects if the camera fails, and swapping the stream out from under
  // startCamera()'s `video.play()` is one - the join screen would show a camera error for a camera
  // that is about to work. The window is real: `video.srcObject` is set before the models are, and
  // a player who glances at a notification during startup lands squarely in it.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      vibrate() {},
      wakeLock: null,
      mediaDevices: {
        getUserMedia: async () => {
          await held;
          const stream = fakeStream();
          granted.push({ stream, constraints: {} });
          return stream;
        },
      },
    },
    writable: true,
    configurable: true,
  });
  granted = [];

  const opening = camera.prepareCameraAndDetector();
  await settle();
  assert.equal(video.srcObject, null, 'precondition: the start is still waiting for the stream');

  const resume = camera.resumeCamera();
  await settle();
  // The resume must not have decided anything yet - there is a start in flight.
  assert.equal(granted.length, 0, 'the resume requested a stream of its own mid-start');

  release();
  await settle();
  await settle();
  const started = video.srcObject;
  assert.equal(granted.length, 1, 'the start got its stream');
  // Now the resume is free to run, and the stream it inspects is the one the start installed.
  video.currentTime = 3.3;
  await run();
  await resume;
  await opening;
  assert.equal(video.srcObject, started, 'the resume must not have replaced the stream it waited for');
  assert.equal(granted.length, 1);
});
