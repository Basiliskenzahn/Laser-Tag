// Person detection with MediaPipe's object detector, running on the phone.

import { FilesetResolver, ObjectDetector } from '/vendor/tasks-vision/vision_bundle.mjs';

const MODEL_URL = '/models/efficientdet_lite0.tflite';
const MIN_SCORE = 0.45;

// The head hitbox is the top-centre part of a person's box.
const HEAD_HEIGHT = 0.2;
const HEAD_WIDTH = 0.5;

export async function createDetector() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    scoreThreshold: MIN_SCORE,
    maxResults: 3,
    categoryAllowlist: ['person'],
  });
  try {
    return { detector: await ObjectDetector.createFromOptions(fileset, options('GPU')), delegate: 'GPU' };
  } catch (err) {
    console.warn('GPU delegate unavailable, falling back to CPU', err);
    return { detector: await ObjectDetector.createFromOptions(fileset, options('CPU')), delegate: 'CPU' };
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
  }));
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
