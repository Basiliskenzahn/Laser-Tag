// Getting the hardware going: the back camera, the on-device models, and the screen wake lock.
//
// All of it is loaded once, lazily, on the way into the lobby, and parked in `state` so that a
// second visit to the scan or game screen reuses the same stream and the same models instead of
// paying for them again. Re-identification (reid.js) is optional: if its model will not load the
// game carries on with the colour + MobileNet signature alone.
//
// prepareCameraAndDetector() resolves as soon as the lobby can open - the camera and the object
// detector - and not when every model has loaded. startup.js owns that split and explains why;
// this module is where it is wired to the real camera and the real models, and it is also what
// answers "has the embedder landed yet?" for the one screen that has to care (screens/scan.js).
//
// Loading a model is not the same as being able to run one. MediaPipe compiles its WebGL shaders
// and ONNX Runtime builds its WASM kernels on a model's *first* inference, long after the model
// itself has loaded, and that first inference costs far more than the ones after it. It used to be
// paid wherever the first real frame happened to fall, which made it a lottery: a phone that
// scanned somebody in the lobby paid it during the scan, while a phone that was only ever scanned
// by other people paid it during the countdown, with the player already trying to aim. So every
// model that loads now gets one throwaway inference up front - see warmUpModels.
//
// That warm-up is now per model, as each one arrives, rather than one batch once everything has
// loaded: the models no longer finish together, and a model that arrived after the player reached
// the lobby has exactly the same unpaid first inference as one that arrived before.

import { DEBUG, video } from './env.js';
import { beginStartup, startupTimingLine } from './startup.js';
import { createEmbedder, createObjectDetector, createPoseDetector, createVisionFileset, detectTrackedPeopleFast } from './detector.js';
import { createReid } from './reid.js';
import { state } from './state.js';

// How long enrolment will wait for an optional model before going ahead without it. Only a hung
// download can reach this: every create path resolves to null rather than hanging on failure. It
// exists so a dead network degrades the scan (a weaker gallery, which the player can redo) rather
// than leaving the scan screen stuck on "Finishing ... load" with no way forward but the ✕.
const SCAN_MODEL_WAIT_MS = 20_000;

// Which optional models enrolment actually reads, and what to call them in the status line:
// the embedder goes into every gallery signature and re-identification into every chosen sample,
// so both decide gallery quality for the rest of the round; the pose landmarker only rescues
// recorded frames the object detector found nobody in.
const SCAN_MODEL_LABELS = {
  embedder: 'the embedder',
  reid: 'the recogniser',
  poseDetector: 'the pose model',
};

// The live startup, for the questions enrolment asks of it. Replaced on every trip through
// prepareCameraAndDetector, because leaving the lobby keeps the models but a retry after a camera
// failure starts again.
let startup = null;

export async function prepareCameraAndDetector() {
  // Models already in `state` have been through the warm-up (and probably a round) once already,
  // so this call neither reloads nor re-warms them. The object detector standing in for all three
  // MediaPipe models is deliberate: they are created together, so if it is there the other two
  // have had their chance, and a phone that could not manage one of them should not retry it on
  // every visit to the lobby. Re-identification is retried, because it is a separate download.
  const hadVision = Boolean(state.detector);
  const hadReid = Boolean(state.reid);

  startup = beginStartup({
    startCamera: () => (video.srcObject ? undefined : startCamera()),
    createFileset: () => (hadVision ? null : createVisionFileset()),
    createObjectDetector: hadVision
      ? () => ({ detector: state.detector, delegate: state.objectDelegate })
      : createObjectDetector,
    createPoseDetector: hadVision ? () => state.poseDetector : createPoseDetector,
    createEmbedder: hadVision ? () => state.embedder : createEmbedder,
    createReid: hadReid ? () => state.reid : createReid,
    onModel(name, model) {
      state[name] = model;
      refreshDelegateLabel();
    },
    warmUp(name, model) {
      // A reused model keeps the warm frame it already had; only a freshly created one needs one.
      if (name === 'reid' ? hadReid : hadVision) return;
      scheduleWarmUp({ [name]: model }, { fresh: true });
    },
  });

  if (DEBUG) startup.models.all.then(() => console.debug(startupTimingLine()));

  const { detector, delegate } = await startup.ready;
  state.detector = detector;
  state.objectDelegate = delegate;
  refreshDelegateLabel();
  if (!hadVision) scheduleWarmUp({ detector }, { fresh: true });
}

// `GPU+Pose+Embed+ReID`, for the debug overlay's first line. Rebuilt from `state` every time a
// model lands rather than assembled once, because the optional three now arrive separately and
// the suffixes are how the overlay reports which of them this phone actually got.
function refreshDelegateLabel() {
  state.delegate =
    `${state.objectDelegate}` +
    `${state.poseDetector ? '+Pose' : ''}${state.embedder ? '+Embed' : ''}${state.reid ? '+ReID' : ''}`;
}

// ---- What enrolment has to wait for ----

// The optional models enrolment reads and has not seen land yet, named for the status line. Empty
// is the normal case: the lobby takes a deliberate tap to leave, which these usually outlast.
export function pendingScanModels() {
  return (startup?.pending() ?? []).map((name) => SCAN_MODEL_LABELS[name]);
}

// Resolves once every optional model has either landed or failed - or once SCAN_MODEL_WAIT_MS has
// passed, so a hung download cannot pin the scan screen open. Never rejects.
export function whenScanModelsReady() {
  return startup ? startup.waitForOptional(SCAN_MODEL_WAIT_MS) : Promise.resolve();
}

// ---- First-inference warm-up (see the header) ----

// The frame is a throwaway canvas rather than the <video> element because gameplay infers on a
// downscaled canvas too (gameplayInferenceSource in screens/game.js), so this both matches the
// code path the round will use and keeps the warm-up from touching anything the real pipeline
// owns. Kept in step with GAME_DETECT_MAX_WIDTH there.
const WARMUP_MAX_WIDTH = 512;
// Shape of the blank frame used when the camera has no frame to copy yet: the same width, and the
// 16:9 the camera is asked for, so the shaders are compiled for the size the round will use.
const WARMUP_FALLBACK_WIDTH = WARMUP_MAX_WIDTH;
const WARMUP_FALLBACK_HEIGHT = 288;
// Low enough to be below every timestamp the game can pass. MediaPipe's VIDEO mode rejects a
// timestamp that does not strictly increase per task, and every real call derives one from
// performance.now() - including identify.js's embedTimestamp counter, which starts at 0 but jumps
// straight to Math.round(performance.now()) on its first call. Milliseconds since page load are
// already in the thousands by the time any model finishes loading, so nothing can land under this.
const WARMUP_TIMESTAMP_MS = 1;
// Roughly where a person stands in frame, so the embedder and re-identification warm their crop
// paths rather than being handed the whole frame.
const WARMUP_REGION = { left: 0.3, top: 0.08, right: 0.7, bottom: 0.95 };

function warmUpFrame() {
  const frame = document.createElement('canvas');
  frame.width = WARMUP_FALLBACK_WIDTH;
  frame.height = WARMUP_FALLBACK_HEIGHT;
  // Nothing to copy if the stream was stopped again, or the tab was hidden before it produced a
  // frame. The blank canvas above compiles the same shaders; it just has nothing to find in them.
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return frame;
  try {
    const scale = Math.min(1, WARMUP_MAX_WIDTH / video.videoWidth);
    frame.width = Math.max(1, Math.round(video.videoWidth * scale));
    frame.height = Math.max(1, Math.round(video.videoHeight * scale));
    frame.getContext('2d').drawImage(video, 0, 0, frame.width, frame.height);
  } catch (err) {
    console.warn('Warm-up frame unavailable; warming on a blank frame', err);
  }
  return frame;
}

function warmUpBox(frame) {
  return {
    x: frame.width * WARMUP_REGION.left,
    y: frame.height * WARMUP_REGION.top,
    w: frame.width * (WARMUP_REGION.right - WARMUP_REGION.left),
    h: frame.height * (WARMUP_REGION.bottom - WARMUP_REGION.top),
  };
}

// The warm-up is only correct while no screen that infers has started: once the scan or game loop
// has fed a model a performance.now() timestamp, WARMUP_TIMESTAMP_MS would be a step backwards.
// Those loops only run in 'scan' and 'game' mode, so this is the test for "nothing has inferred
// yet" - and in those modes the first inference has been paid anyway, which is the whole point.
//
// `fresh` is the exception, and it exists because the models no longer all load before the player
// leaves the join screen (startup.js): one can land while the scan screen is already up. Two
// different things were being conflated here. MediaPipe's monotonic-timestamp rule is *per task
// instance*, and a task created a moment ago has never been handed a timestamp by anyone, so
// WARMUP_TIMESTAMP_MS cannot be a step backwards for it whatever mode the app is in. And the
// second reason to stand down - "the first inference has been paid anyway" - is simply untrue of
// a model that did not exist when those loops started. Without this, a late embedder would have
// its first inference paid in the middle of processing a rotation, which is the exact cost the
// whole warm-up exists to move. Enrolment waits for these models before its countdown, so the
// warm frame lands in that wait rather than under the crosshair.
function nothingHasInferredYet() {
  return state.mode === 'join' || state.mode === 'lobby';
}

// A warm-up that throws has cost the player nothing, so it is only ever logged, and each model is
// wrapped on its own so one odd model does not deny the others their warm frame. The models all
// still work cold; cold is exactly where this started.
function warmUpStep(label, run, fresh) {
  if (!fresh && !nothingHasInferredYet()) return undefined;
  try {
    return run();
  } catch (err) {
    console.warn(`${label} warm-up skipped`, err);
    return undefined;
  }
}

async function warmUpModels({ detector, poseDetector, embedder, reid }, fresh) {
  const frame = warmUpFrame();
  // Re-identification is the only one that can really overlap with the others (ONNX Runtime, not
  // the MediaPipe graph), so it is started first and settled last. Its crop happens synchronously
  // inside embed(), hence the wrapper around the call as well as the catch on its promise.
  const reidWarm = reid
    ? warmUpStep('Re-identification', () => reid.embed(frame, warmUpBox(frame)), fresh)?.catch((err) =>
        console.warn('Re-identification warm-up failed', err),
      )
    : undefined;
  if (detector) warmUpStep('Detector', () => detectTrackedPeopleFast(detector, frame, WARMUP_TIMESTAMP_MS), fresh);
  if (poseDetector) warmUpStep('Pose', () => poseDetector.detectForVideo(frame, WARMUP_TIMESTAMP_MS), fresh);
  if (embedder) {
    warmUpStep('Embedder', () => embedder.embedForVideo(frame, WARMUP_TIMESTAMP_MS, { regionOfInterest: WARMUP_REGION }), fresh);
  }
  await reidWarm;
}

// Fire and forget, a paint after the caller has moved on: the point is to move the first-inference
// cost off the start of the round, and the lobby is the one screen with nothing else to do, so
// there is no reason to make the join screen wait for it too. Reaching a screen that infers takes
// a deliberate tap, which cannot beat two frames; if it somehow does, warmUpStep stands down -
// unless the model is `fresh`, which is a model that has only just been created and so has an
// unpaid first inference whatever screen is up (see nothingHasInferredYet).
function scheduleWarmUp(models, { fresh = false } = {}) {
  if (!models.detector && !models.poseDetector && !models.embedder && !models.reid) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      warmUpModels(models, fresh).catch((err) => console.warn('Model warm-up skipped', err));
    }),
  );
}

export function startupErrorMessage(err) {
  if (!window.isSecureContext) {
    return 'The camera only works over HTTPS. Open the https:// address the server printed.';
  }
  if (err.name === 'NotAllowedError') return 'Camera access was blocked. Allow it in your browser settings and try again.';
  if (err.name === 'NotFoundError') return 'No camera found on this device.';
  return `Could not start: ${err.message || err}`;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API not available');
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  await video.play();
}

export function stopCamera() {
  for (const track of video.srcObject?.getTracks?.() ?? []) track.stop();
  video.srcObject = null;
}

export async function keepScreenOn() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // Not supported or refused; the game still works.
  }
}
