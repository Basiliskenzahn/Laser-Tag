// Getting the hardware going: the back camera, the on-device models, and the screen wake lock.
//
// All of it is loaded once, lazily, on the way into the lobby, and parked in `state` so that a
// second visit to the scan or game screen reuses the same stream and the same models instead of
// paying for them again. Re-identification (reid.js) is optional: if its model will not load the
// game carries on with the colour + MobileNet signature alone.
//
// Loading a model is not the same as being able to run one. MediaPipe compiles its WebGL shaders
// and ONNX Runtime builds its WASM kernels on a model's *first* inference, long after the model
// itself has loaded, and that first inference costs far more than the ones after it. It used to be
// paid wherever the first real frame happened to fall, which made it a lottery: a phone that
// scanned somebody in the lobby paid it during the scan, while a phone that was only ever scanned
// by other people paid it during the countdown, with the player already trying to aim. So every
// model that loads now gets one throwaway inference up front - see warmUpModels.

import { createDetector, detectTrackedPeopleFast } from './detector.js';
import { createReid } from './reid.js';
import { video } from './env.js';
import { state } from './state.js';

export async function prepareCameraAndDetector() {
  // Which models this call is responsible for warming: the ones it creates itself. Anything
  // already in `state` has been through the warm-up (and probably a round) once already.
  const hadVision = Boolean(state.detector);
  const hadReid = Boolean(state.reid);
  const camera = video.srcObject ? Promise.resolve() : startCamera();
  const detector = state.detector
    ? Promise.resolve({
        detector: state.detector,
        poseDetector: state.poseDetector,
        embedder: state.embedder,
        delegate: state.delegate,
      })
    : createDetector();
  // Person re-identification (reid.js); the colour + MobileNet signature still works without it.
  const reid = state.reid
    ? Promise.resolve(state.reid)
    : createReid().catch((err) => {
        console.warn('Re-identification model unavailable', err);
        return null;
      });
  const [, vision, reidModel] = await Promise.all([camera, detector, reid]);
  state.detector = vision.detector;
  state.poseDetector = vision.poseDetector;
  state.embedder = vision.embedder;
  state.reid = reidModel;
  state.delegate = `${vision.delegate.replace('+ReID', '')}${reidModel ? '+ReID' : ''}`;
  scheduleWarmUp({
    detector: hadVision ? null : state.detector,
    poseDetector: hadVision ? null : state.poseDetector,
    embedder: hadVision ? null : state.embedder,
    reid: hadReid ? null : state.reid,
  });
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
function nothingHasInferredYet() {
  return state.mode === 'join' || state.mode === 'lobby';
}

// A warm-up that throws has cost the player nothing, so it is only ever logged, and each model is
// wrapped on its own so one odd model does not deny the others their warm frame. The models all
// still work cold; cold is exactly where this started.
function warmUpStep(label, run) {
  if (!nothingHasInferredYet()) return undefined;
  try {
    return run();
  } catch (err) {
    console.warn(`${label} warm-up skipped`, err);
    return undefined;
  }
}

async function warmUpModels({ detector, poseDetector, embedder, reid }) {
  const frame = warmUpFrame();
  // Re-identification is the only one that can really overlap with the others (ONNX Runtime, not
  // the MediaPipe graph), so it is started first and settled last. Its crop happens synchronously
  // inside embed(), hence the wrapper around the call as well as the catch on its promise.
  const reidWarm = reid
    ? warmUpStep('Re-identification', () => reid.embed(frame, warmUpBox(frame)))?.catch((err) =>
        console.warn('Re-identification warm-up failed', err),
      )
    : undefined;
  if (detector) warmUpStep('Detector', () => detectTrackedPeopleFast(detector, frame, WARMUP_TIMESTAMP_MS));
  if (poseDetector) warmUpStep('Pose', () => poseDetector.detectForVideo(frame, WARMUP_TIMESTAMP_MS));
  if (embedder) {
    warmUpStep('Embedder', () => embedder.embedForVideo(frame, WARMUP_TIMESTAMP_MS, { regionOfInterest: WARMUP_REGION }));
  }
  await reidWarm;
}

// Fire and forget, a paint after the caller has moved on: the point is to move the first-inference
// cost off the start of the round, and the lobby is the one screen with nothing else to do, so
// there is no reason to make the join screen wait for it too. Reaching a screen that infers takes
// a deliberate tap, which cannot beat two frames; if it somehow does, warmUpStep stands down.
function scheduleWarmUp(models) {
  if (!models.detector && !models.poseDetector && !models.embedder && !models.reid) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      warmUpModels(models).catch((err) => console.warn('Model warm-up skipped', err));
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
