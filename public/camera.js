// Getting the hardware going: the back camera, the on-device models, and the screen wake lock.
//
// All of it is loaded once, lazily, on the way into the lobby, and parked in `state` so that a
// second visit to the scan or game screen reuses the same stream and the same models instead of
// paying for them again. Re-identification (reid.js) is optional: if its model will not load the
// game carries on with the colour + MobileNet signature alone.

import { createDetector } from './detector.js';
import { createReid } from './reid.js';
import { video } from './env.js';
import { state } from './state.js';

export async function prepareCameraAndDetector() {
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
