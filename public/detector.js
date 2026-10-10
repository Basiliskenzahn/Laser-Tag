// Person detection with MediaPipe's object detector, running on the phone.

import { FilesetResolver, ObjectDetector, PoseLandmarker } from '/vendor/tasks-vision/vision_bundle.mjs';

const OBJECT_MODEL_URL = '/models/efficientdet_lite0.tflite';
const POSE_MODEL_URL = '/models/pose_landmarker_lite.task';
const MIN_SCORE = 0.35;
const POSE_MIN_LANDMARKS = 8;

// The head hitbox is the top-centre part of a person's box.
const HEAD_HEIGHT = 0.2;
const HEAD_WIDTH = 0.5;

export async function createDetector() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
  const objectOptions = (delegate) => ({
    baseOptions: { modelAssetPath: OBJECT_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    scoreThreshold: MIN_SCORE,
    maxResults: 3,
    categoryAllowlist: ['person'],
  });
  const poseOptions = (delegate) => ({
    baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.25,
    minPosePresenceConfidence: 0.25,
    minTrackingConfidence: 0.25,
  });

  let detector;
  let objectDelegate = 'GPU';
  try {
    detector = await ObjectDetector.createFromOptions(fileset, objectOptions('GPU'));
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU', err);
    detector = await ObjectDetector.createFromOptions(fileset, objectOptions('CPU'));
    objectDelegate = 'CPU';
  }

  let poseDetector = null;
  let poseDelegate = '';
  try {
    poseDetector = await PoseLandmarker.createFromOptions(fileset, poseOptions(objectDelegate));
    poseDelegate = '+Pose';
  } catch (err) {
    console.warn('Pose scan fallback unavailable', err);
  }

  return { detector, poseDetector, delegate: `${objectDelegate}${poseDelegate}` };
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

function poseBoxes(poseDetector, source, timestamp) {
  if (!poseDetector) return [];
  const result = poseDetector.detectForVideo(source, timestamp);
  const sw = sourceWidth(source);
  const sh = sourceHeight(source);
  return (result.landmarks ?? [])
    .map((landmarks) => {
      const visible = landmarks.filter((p) => (p.visibility ?? 1) >= 0.35 && p.x >= -0.15 && p.x <= 1.15 && p.y >= -0.15 && p.y <= 1.15);
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
      const padX = Math.max(0.05, (maxX - minX) * 0.2);
      const padTop = Math.max(0.06, (maxY - minY) * 0.18);
      const padBottom = Math.max(0.08, (maxY - minY) * 0.24);
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

export function detectScanPeople(detector, poseDetector, source, timestamp) {
  const boxes = [...detectPeople(detector, source, timestamp), ...poseBoxes(poseDetector, source, timestamp)];
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of boxes) {
    if (kept.every((other) => overlap(box, other) < 0.45)) kept.push(box);
  }
  return kept;
}

export function headBox(box) {
  const w = box.w * HEAD_WIDTH;
  return { x: box.x + (box.w - w) / 2, y: box.y, w, h: box.h * HEAD_HEIGHT };
}

export function contains(box, px, py) {
  return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
}

// 'head', 'body' or null for whatever is under the point (px, py).
export function hitTest(boxes, px, py) {
  let zone = null;
  for (const box of boxes) {
    if (!contains(box, px, py)) continue;
    if (contains(headBox(box), px, py)) return 'head';
    zone = 'body';
  }
  return zone;
}
