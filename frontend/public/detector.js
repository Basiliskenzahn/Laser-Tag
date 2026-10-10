// Person detection with MediaPipe's object detector, running on the phone.
//
// This module only finds *where* the people are; identify.js decides who they are. It also owns
// the gameplay hitboxes, because they are derived from the same boxes.
//
// There are three detection entry points because the phone cannot afford the good one every
// frame, and the three jobs want different trade-offs:
//
//   detectScanPeople        - enrolment. One cooperative person, posed, and a missed frame just
//                             means a slower scan. Takes the union of the object detector and
//                             the pose landmarker so an unusual pose still gets a box, and only
//                             drops near-identical duplicates.
//   detectTrackedPeople     - gameplay, the thorough pass. Adds the pose landmarker to do the
//                             two things the object detector gets wrong with people close
//                             together: it splits a single box that actually holds two people,
//                             and it recovers a person the object detector missed entirely.
//                             app.js runs it only every few hundred ms, and only once more than
//                             one player is enrolled (nothing to confuse before that).
//   detectTrackedPeopleFast - gameplay, every other frame. The object detector alone, which is
//                             several times cheaper. Identity rides along on the tracker between
//                             thorough passes, so the cheap boxes are enough most of the time.
//
// detectPeople is the shared raw object-detector pass underneath all three.

import { FilesetResolver, ImageEmbedder, ObjectDetector, PoseLandmarker } from '/vendor/tasks-vision/vision_bundle.mjs';

const OBJECT_MODEL_URL = '/models/efficientdet_lite0.tflite';
const POSE_MODEL_URL = '/models/pose_landmarker_lite.task';
const EMBEDDER_MODEL_URL = '/models/mobilenet_v3_small_embedder.tflite';
const MIN_SCORE = 0.35;
const POSE_MIN_LANDMARKS = 6;
const TRACKED_POSE_MIN_SCORE = 0.55;

// Gameplay hitboxes are intentionally tighter than detector boxes. Detector boxes need to
// include pose variation and loose arms for tracking; shots should hit the head/torso, not
// empty padding or outstretched arms.
const HEAD_TOP = 0.02;
const HEAD_HEIGHT = 0.18;
const HEAD_WIDTH = 0.34;
const BODY_TOP = 0.22;
const BODY_HEIGHT = 0.72;
const BODY_WIDTH = 0.56;

// ---- Loading the models ----
//
// Three models, 17.1 MB of them, and only one is required. The pose landmarker and the image
// embedder are both best-effort: the caller gets null for whichever one this device could not
// manage (identify.js blends in the embedder only when it exists, and the detect* functions below
// tolerate a null poseDetector), so nothing the player can see has to wait for them.
//
// They are exposed one model per function rather than as a single createDetector() because the
// three are not equally urgent and startup.js needs to say so. The object detector (7.25 MB) is
// the one the lobby cannot open without; the pose landmarker (5.78 MB) and the embedder (4.12 MB)
// are only needed by the time somebody taps Scan, which is a deliberate tap away. Loading all
// three before showing the lobby is what made entering a room feel broken.
//
// The one real ordering constraint is the delegate. Whether MediaPipe can use the GPU at all is
// only discovered by trying, and the try that matters is the object detector's, because that is
// the model the game runs every frame. Pose and the embedder are then created with whatever it
// settled on, so the three never end up split across GPU and CPU - see startup.js, which is where
// that sequencing lives.

const WASM_PATH = '/vendor/tasks-vision/wasm';

export function createVisionFileset() {
  return FilesetResolver.forVisionTasks(WASM_PATH);
}

// Required. Returns the delegate it managed, which the other two are then created with; `delegate`
// is also what the debug overlay's first line shows.
export async function createObjectDetector(fileset) {
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: OBJECT_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    scoreThreshold: MIN_SCORE,
    maxResults: 8,
    categoryAllowlist: ['person'],
  });
  try {
    return { detector: await ObjectDetector.createFromOptions(fileset, options('GPU')), delegate: 'GPU' };
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU', err);
    return { detector: await ObjectDetector.createFromOptions(fileset, options('CPU')), delegate: 'CPU' };
  }
}

// Best-effort; null means this phone goes without it.
export async function createPoseDetector(fileset, delegate) {
  try {
    return await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 8,
      minPoseDetectionConfidence: 0.18,
      minPosePresenceConfidence: 0.18,
      minTrackingConfidence: 0.18,
    });
  } catch (err) {
    console.warn('Pose scan fallback unavailable', err);
    return null;
  }
}

// Best-effort; null means identify.js leaves `embed` out of the blend.
export async function createEmbedder(fileset, delegate) {
  try {
    return await ImageEmbedder.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: EMBEDDER_MODEL_URL, delegate },
      runningMode: 'VIDEO',
      l2Normalize: true,
      quantize: false,
    });
  } catch (err) {
    console.warn('Image embedder unavailable', err);
    return null;
  }
}

// Person boxes in video pixel coordinates.
export function detectPeople(detector, video, timestamp) {
  return detector.detectForVideo(video, timestamp).detections.map((d) => ({
    x: d.boundingBox.originX,
    y: d.boundingBox.originY,
    w: d.boundingBox.width,
    h: d.boundingBox.height,
    score: d.categories[0]?.score ?? 0,
    source: 'object',
  }));
}

function sourceWidth(source) {
  return source.videoWidth || source.width || 1;
}

function sourceHeight(source) {
  return source.videoHeight || source.height || 1;
}

// Boxes around whatever bodies the pose landmarker found, padded out from the visible landmarks
// to roughly what the object detector would have drawn (landmarks stop at the skin, and limbs
// out of frame pull the bounds in). `score` here is the fraction of landmarks it could see, so it
// doubles as a confidence: a half-occluded person scores low.
function poseBoxes(poseDetector, source, timestamp) {
  if (!poseDetector) return [];
  const result = poseDetector.detectForVideo(source, timestamp);
  const sw = sourceWidth(source);
  const sh = sourceHeight(source);
  return (result.landmarks ?? [])
    .map((landmarks) => {
      const visible = landmarks.filter((p) => (p.visibility ?? 1) >= 0.2 && p.x >= -0.2 && p.x <= 1.2 && p.y >= -0.2 && p.y <= 1.2);
      if (visible.length < POSE_MIN_LANDMARKS) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const point of visible) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
      const height = Math.max(0.01, maxY - minY);
      const padX = Math.max(0.055, (maxX - minX) * 0.24, height * 0.08);
      const padTop = Math.max(0.06, height * 0.14);
      const padBottom = Math.max(0.1, height * 0.28);
      const x = Math.max(0, (minX - padX) * sw);
      const y = Math.max(0, (minY - padTop) * sh);
      const right = Math.min(sw, (maxX + padX) * sw);
      const bottom = Math.min(sh, (maxY + padBottom) * sh);
      return { x, y, w: right - x, h: bottom - y, score: visible.length / landmarks.length, source: 'pose' };
    })
    .filter((box) => box && box.w > 4 && box.h > 8);
}

function overlap(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function coveredBy(inner, outer) {
  const x1 = Math.max(inner.x, outer.x);
  const y1 = Math.max(inner.y, outer.y);
  const x2 = Math.min(inner.x + inner.w, outer.x + outer.w);
  const y2 = Math.min(inner.y + inner.h, outer.y + outer.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / Math.max(1, inner.w * inner.h);
}

function centerDistanceRatio(a, b) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const scale = Math.max(a.w, a.h, b.w, b.h, 1);
  return Math.hypot(ax - bx, ay - by) / scale;
}

// Highest-confidence-first greedy suppression: keep a box only if it is distinct from every box
// already kept. Sorts `boxes` in place, so callers pass an array they own.
function keepDistinct(boxes, isDistinct) {
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of boxes) if (kept.every((other) => isDistinct(box, other))) kept.push(box);
  return kept;
}

// Enrolment: cast the widest net. Both detectors' boxes, and only near-duplicates removed - the
// caller picks the best usable box out of the result (identify.js usableScanBox).
export function detectScanPeople(detector, poseDetector, source, timestamp) {
  return keepDistinct(
    [...detectPeople(detector, source, timestamp), ...poseBoxes(poseDetector, source, timestamp)],
    (box, other) => overlap(box, other) < 0.75,
  );
}

// Gameplay, thorough pass. Two people standing close together are the case that matters most
// here, because one box over two people gets one identity and the wrong player takes the hit.
export function detectTrackedPeople(detector, poseDetector, source, timestamp) {
  const objectBoxes = detectPeople(detector, source, timestamp);
  const poses = poseBoxes(poseDetector, source, timestamp).filter((poseBox) => poseBox.score >= TRACKED_POSE_MIN_SCORE);
  // An object box that two separate, well-separated poses both sit inside is one box over two
  // people: throw it away and let the poses stand in for it.
  const splitObjects = new Set(
    objectBoxes.filter(
      (objectBox) =>
        poses.filter((poseBox) => coveredBy(poseBox, objectBox) > 0.62 && centerDistanceRatio(poseBox, objectBox) > 0.18).length >= 2,
    ),
  );
  const keptObjects = objectBoxes.filter((objectBox) => !splitObjects.has(objectBox));
  // ...and a pose nowhere near any surviving object box is a person the object detector missed.
  const poseFallbacks = poses.filter((poseBox) =>
    keptObjects.every((objectBox) => overlap(poseBox, objectBox) < 0.12 && centerDistanceRatio(poseBox, objectBox) > 0.65),
  );
  return keepDistinct(
    [...keptObjects, ...poseFallbacks],
    (box, other) => overlap(box, other) < 0.5 && centerDistanceRatio(box, other) > 0.55,
  );
}

// Gameplay, cheap pass: the object detector alone, suppressed the same way as the thorough pass
// so the two produce comparable boxes and the tracker can associate across a switch between them.
export function detectTrackedPeopleFast(detector, source, timestamp) {
  return keepDistinct(
    detectPeople(detector, source, timestamp),
    (box, other) => overlap(box, other) < 0.5 && centerDistanceRatio(box, other) > 0.55,
  );
}

// Head and body hitboxes, both centred horizontally in the detector box (see the HEAD_*/BODY_*
// constants above for why they are tighter than it).
export function headBox(box) {
  const w = box.w * HEAD_WIDTH;
  return { x: box.x + (box.w - w) / 2, y: box.y + box.h * HEAD_TOP, w, h: box.h * HEAD_HEIGHT };
}

export function bodyBox(box) {
  const w = box.w * BODY_WIDTH;
  return { x: box.x + (box.w - w) / 2, y: box.y + box.h * BODY_TOP, w, h: box.h * BODY_HEIGHT };
}

export function contains(box, px, py) {
  return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
}
