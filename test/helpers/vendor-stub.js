// Stands in for '/vendor/tasks-vision/vision_bundle.mjs', the one absolute-URL import in the
// front end (detector.js). Node will not resolve a leading-slash specifier, which is what used to
// make every module downstream of detector.js - screens/scan.js included - impossible to import
// under `node --test`. vendor-hooks.js points that specifier here.
//
// Nothing in a test ever calls these: the detector, pose landmarker and embedder are injected as
// fakes through `state`. They exist only so the module graph resolves.
export class FilesetResolver {
  static forVisionTasks() {
    throw new Error('vendor stub: the real MediaPipe bundle is not available under Node');
  }
}

const unavailable = (name) => ({
  createFromOptions() {
    throw new Error(`vendor stub: ${name} is not available under Node`);
  },
});

export const ImageEmbedder = unavailable('ImageEmbedder');
export const ObjectDetector = unavailable('ObjectDetector');
export const PoseLandmarker = unavailable('PoseLandmarker');
