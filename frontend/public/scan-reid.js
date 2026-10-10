// The last and most expensive step of enrolment: the OSNet re-identification embedding for the
// scan samples that survived selection (screens/scan.js runs the rest of the scan).
//
// It is deferred to here rather than computed per recorded frame because selection scores
// candidates on colour alone - signatureSimilarity never looks at `reid` - so embedding every
// usable frame meant paying for the single most expensive inference in the app on frames that
// selection then threw away. That ordering is what makes the embedding affordable, and it is
// described in docs/client/scanning.md; do not move it back.
//
// This module exists on its own for two reasons. It is the only concurrent thing in the scan,
// and it is the step that decides what `reid` vector ends up in a cached gallery for the rest of
// the round, so both the concurrency and the arithmetic are worth being able to test directly
// (test/scan-reid.test.js) rather than only through a screen that needs a camera.
//
// Why it dispatches a batch instead of one at a time: reid.js runs OSNet in a Web Worker
// (`ort.env.wasm.proxy`) and queues one inference at a time internally, so the only main-thread
// cost of an embed() call is the crop it snapshots synchronously before handing over. Embedding
// one frame and then yielding to the renderer in front of each left the worker idle for most of a
// frame per embedding - on a scan with 30 backing frames, about half a second of doing nothing on
// top of the inferences themselves. Dispatching a batch and then yielding keeps the worker fed,
// and the batch size is only about how long an uninterrupted run of snapshots may be.
//
// None of that changes what lands in the gallery: the same frames, embedded once each, averaged
// the same way per sample. Only the order the work is issued in moved.

// Embeddings dispatched before yielding to the renderer.
export const REID_DISPATCH_BATCH = 4;

// The same arithmetic averageSignatures uses for every other vector field (averageVectors in
// identify.js): the mean, L2-normalised. A single vector is passed through untouched, because
// reid.js already returns a normalised one.
export function averageReidVectors(vectors) {
  if (vectors.length === 1) return vectors[0];
  const len = Math.max(0, ...vectors.map((v) => v?.length ?? 0));
  if (!len) return [];
  const avg = new Array(len).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < len; i++) avg[i] += Number.isFinite(vector?.[i]) ? vector[i] : 0;
  }
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    avg[i] /= vectors.length;
    sumSq += avg[i] * avg[i];
  }
  const norm = Math.sqrt(sumSq) || 1;
  return avg.map((v) => v / norm);
}

// Every frame backing a chosen sample, each one once: two samples that share a frame embed it
// once between them. A sample with no `sources` is a single-frame sample and is its own source
// (selectRotationSamples produces both shapes - see the asymmetry note in scanning.md).
export function reidSourceFrames(samples) {
  const sources = new Map(); // frame index -> the sample source that frame came from
  for (const sample of samples) {
    for (const source of sample.sources ?? [sample]) {
      if (!sources.has(source.frameIndex)) sources.set(source.frameIndex, source);
    }
  }
  return sources;
}

// Writes `signature.reid` on each sample and resolves true, or resolves false without touching a
// single signature if the scan was cancelled. Rejects if an inference failed, which is what keeps
// one model error failing the whole scan rather than producing a gallery with some embeddings
// missing - the caller turns that into "Could not process the rotation video".
//
//   embed(image, box)  -> Promise<vector>, reid.js's one-off enrolment embedder
//   yieldTo()          -> Promise, a renderer yield between batches
//   cancelled()        -> true once the player has cancelled
//   onProgress(done, total)
export async function attachSampleReid(samples, { embed, yieldTo, cancelled = () => false, onProgress = () => {} }) {
  const sources = reidSourceFrames(samples);
  const entries = [...sources];
  let done = 0;
  onProgress(done, entries.length);

  // Both handlers are attached at dispatch time, not when the batch is later awaited. A batch is
  // several renderer yields old by the time anything awaits it, and a promise that rejects with
  // nothing listening is an unhandled rejection - so the error is caught here and re-thrown below
  // once every dispatched inference has settled.
  let failure = null;
  const pending = new Map(); // frame index -> Promise<vector|null>
  for (let i = 0; i < entries.length && !cancelled() && !failure; i += REID_DISPATCH_BATCH) {
    for (const [frameIndex, source] of entries.slice(i, i + REID_DISPATCH_BATCH)) {
      pending.set(
        frameIndex,
        Promise.resolve()
          .then(() => embed(source.image, source.box))
          .then(
            (vector) => {
              done++;
              onProgress(done, entries.length);
              return vector;
            },
            (err) => {
              failure ??= err;
              return null;
            },
          ),
      );
    }
    await yieldTo();
  }

  const vectors = new Map(await Promise.all([...pending].map(async ([index, vector]) => [index, await vector])));
  // One bad inference fails the scan rather than enrolling a gallery with holes in it, and it
  // stops the loop above dispatching the frames that were still to come.
  if (failure) throw failure;
  if (cancelled()) return false;

  for (const sample of samples) {
    const found = (sample.sources ?? [sample]).map((source) => vectors.get(source.frameIndex)).filter((v) => v?.length);
    if (found.length) sample.signature.reid = averageReidVectors(found);
  }
  return true;
}
