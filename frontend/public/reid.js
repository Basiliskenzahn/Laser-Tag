// Person re-identification embeddings: who someone is, from their whole-body appearance.
//
// OSNet x0.25 (Zhou et al., "Omni-Scale Feature Learning for Person Re-Identification"), trained
// on MSMT17 by the Torchreid authors (MIT licence) and exported to ONNX. Unlike the colour
// features and the generic MobileNet embedding, it was trained specifically to tell people apart
// across cameras, angles and lighting. On Market-1501 (people it never saw), in games of 2-4
// enrolled players with 20 bystanders each, it recognised 77% of players at a 5% bystander
// acceptance rate, against 34% for the colour + MobileNet signature.
//
// Because of that, it overrides the other appearance signals outright rather than being blended
// with them: identify.js has the full priority order of the four identification signals.
//
// Inference runs in ONNX Runtime Web (WebAssembly) and is asynchronous, so embeddings are
// requested and picked up later rather than computed inline:
//   const reid = await createReid();
//   reid.request(key, source, box);   // snapshot the crop now, embed in the background
//   reid.latest(key, maxAgeMs)        // the most recent embedding for that key, or null
//   await reid.embed(source, box)     // one-off, for enrolment

import * as ort from '/vendor/ort/ort.wasm.min.mjs';

const MODEL_URL = '/models/osnet_x0_25_msmt17.onnx';
const WIDTH = 128;
const HEIGHT = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const PRECISION = 10_000; // 4 decimals: keeps galleries small on the wire

export const REID_DIMS = 512;

function normalize(vector) {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return Array.from(vector, (v) => Math.round((v / norm) * PRECISION) / PRECISION);
}

export async function createReid() {
  ort.env.wasm.wasmPaths = '/vendor/ort/';
  // Threads need cross-origin isolation; a single thread is plenty for this small model.
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Crop and resize the box to the model's 128x256 input, as ImageNet-normalised CHW floats.
  function snapshot(source, box) {
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const w = Math.max(1, Math.min(box.w, (source.videoWidth || source.width) - x));
    const h = Math.max(1, Math.min(box.h, (source.videoHeight || source.height) - y));
    ctx.drawImage(source, x, y, w, h, 0, 0, WIDTH, HEIGHT);
    const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const plane = WIDTH * HEIGHT;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      input[i] = (data[i * 4] / 255 - MEAN[0]) / STD[0];
      input[plane + i] = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
      input[2 * plane + i] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
    }
    return input;
  }

  // One inference at a time; requests made meanwhile replace each other per key.
  let busy = Promise.resolve();
  async function run(input) {
    const result = busy.then(async () => {
      const out = await session.run({ image: new ort.Tensor('float32', input, [1, 3, HEIGHT, WIDTH]) });
      return normalize(out.features.data);
    });
    busy = result.catch(() => {});
    return result;
  }

  // Keyed by object (e.g. a track), so entries go away with the track.
  const latest = new WeakMap(); // key -> { vector, at }
  const pending = new WeakSet();

  return {
    embed: (source, box) => run(snapshot(source, box)),
    request(key, source, box) {
      if (pending.has(key)) return;
      pending.add(key);
      const at = performance.now();
      run(snapshot(source, box))
        .then((vector) => latest.set(key, { vector, at }))
        .catch((err) => console.warn('reid failed', err))
        .finally(() => pending.delete(key));
    },
    latest(key, maxAgeMs = 800) {
      const entry = latest.get(key);
      return entry && performance.now() - entry.at <= maxAgeMs ? entry.vector : null;
    },
  };
}
