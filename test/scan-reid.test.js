// The deferred OSNet pass at the end of a scan (frontend/public/scan-reid.js).
//
// What matters here is not speed but that the gallery is byte-for-byte what the serial version
// produced, because an enrolled gallery is cached under SCAN_CACHE_VERSION and matched against by
// every phone for the whole round. So the first test embeds a fixed fixture both ways - once
// through the real batched implementation, once through a deliberately naive serial reference -
// and compares the resulting signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REID_DISPATCH_BATCH, attachSampleReid, averageReidVectors, reidSourceFrames } from '../frontend/public/scan-reid.js';

// A deterministic unit vector per frame, standing in for one OSNet embedding.
function vectorFor(frameIndex, length = 8) {
  let seed = (frameIndex + 1) * 2654435761;
  const v = Array.from({ length }, () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  });
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

const source = (frameIndex) => ({ frameIndex, image: `frame-${frameIndex}`, box: { x: frameIndex, y: 0, w: 10, h: 30 } });

// The two sample shapes selectRotationSamples can produce: averaged samples with `sources`, and
// single-frame samples that are their own source. Frames 3 and 7 are deliberately shared between
// two samples each, because "a frame two samples share embeds once" is part of the contract.
function fixture() {
  return [
    { signature: { hist: [1] }, sources: [source(0), source(1), source(2), source(3)] },
    { signature: { hist: [2] }, sources: [source(3), source(4), source(5)] },
    { signature: { hist: [3] }, sources: [source(6), source(7)] },
    { signature: { hist: [4] }, frameIndex: 7, image: 'frame-7', box: { x: 7, y: 0, w: 10, h: 30 } },
    { signature: { hist: [5] }, sources: [source(8)] },
  ];
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

// How the module used to work: one frame at a time, a renderer yield in front of each.
async function serialReference(samples, embed) {
  const embeddings = new Map();
  for (const sample of samples) {
    const vectors = [];
    for (const src of sample.sources ?? [sample]) {
      if (!embeddings.has(src.frameIndex)) {
        await nextTick();
        embeddings.set(src.frameIndex, await embed(src.image, src.box));
      }
      const vector = embeddings.get(src.frameIndex);
      if (vector?.length) vectors.push(vector);
    }
    if (vectors.length) sample.signature.reid = averageReidVectors(vectors);
  }
  return samples;
}

const embedByName = (image) => Promise.resolve(vectorFor(Number(image.split('-')[1])));

test('the batched pass produces exactly the gallery the serial one did', async () => {
  const batched = fixture();
  await attachSampleReid(batched, { embed: embedByName, yieldTo: nextTick });
  const serial = await serialReference(fixture(), embedByName);

  assert.deepEqual(
    batched.map((s) => s.signature.reid),
    serial.map((s) => s.signature.reid),
    'dispatching in batches must not change a single number in the gallery',
  );
  // ...and the vectors are real: averaged, normalised, one per sample.
  for (const sample of batched) {
    assert.equal(sample.signature.reid.length, 8);
    assert.ok(Math.abs(Math.hypot(...sample.signature.reid) - 1) < 1e-12);
  }
  // A single-source sample is its frame's vector untouched (reid.js already normalises).
  assert.deepEqual(batched[4].signature.reid, vectorFor(8));
});

test('a frame two samples share is embedded once', async () => {
  const samples = fixture();
  const seen = [];
  await attachSampleReid(samples, {
    embed: (image, box) => {
      seen.push(image);
      return embedByName(image);
    },
    yieldTo: nextTick,
  });

  assert.equal(seen.length, new Set(seen).size, 'no frame embedded twice');
  // 9 distinct frames across 5 samples whose source lists total 11 entries.
  assert.deepEqual([...new Set(seen)].sort(), Array.from({ length: 9 }, (_, i) => `frame-${i}`).sort());
  assert.equal(reidSourceFrames(samples).size, 9);
});

test('embeddings overlap instead of running one at a time', async () => {
  const samples = fixture();
  let inFlight = 0;
  let peak = 0;
  const release = [];

  const run = attachSampleReid(samples, {
    embed: () =>
      new Promise((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        release.push(() => {
          inFlight--;
          resolve(vectorFor(0));
        });
      }),
    yieldTo: nextTick,
  });

  // Let a batch be dispatched, then check it really is a batch. The serial version this replaced
  // could never have more than one embedding outstanding at a time, so this is the assertion that
  // fails if someone puts the per-frame `await` back in front of each embed.
  await nextTick();
  assert.ok(
    peak >= REID_DISPATCH_BATCH,
    `expected at least ${REID_DISPATCH_BATCH} embeddings in flight at once, saw ${peak}`,
  );

  // Drain, letting each newly dispatched batch arrive.
  while (release.length) {
    release.shift()();
    await nextTick();
  }
  await run;
});

test('a cancel leaves every signature untouched', async () => {
  const samples = fixture();
  let cancelled = false;
  const result = await attachSampleReid(samples, {
    embed: embedByName,
    yieldTo: async () => {
      // Cancel the moment the first batch is out, which is where ✕ lands in practice.
      cancelled = true;
      await nextTick();
    },
    cancelled: () => cancelled,
  });

  assert.equal(result, false, 'the caller must be told, so it returns null rather than a gallery');
  for (const sample of samples) {
    assert.equal(sample.signature.reid, undefined, 'no half-built gallery');
    assert.ok(sample.signature.hist, 'and nothing else disturbed either');
  }
});

test('a cancel stops dispatching further batches', async () => {
  const samples = fixture();
  let cancelled = false;
  let embeds = 0;
  await attachSampleReid(samples, {
    embed: (image) => {
      embeds++;
      return embedByName(image);
    },
    yieldTo: async () => {
      cancelled = true;
      await nextTick();
    },
    cancelled: () => cancelled,
  });
  assert.equal(embeds, REID_DISPATCH_BATCH, 'only the batch already in flight was paid for');
});

test('a failed inference fails the whole scan rather than a gallery with holes', async () => {
  const samples = fixture();
  await assert.rejects(
    attachSampleReid(samples, {
      embed: (image) => (image === 'frame-5' ? Promise.reject(new Error('onnx died')) : embedByName(image)),
      yieldTo: nextTick,
    }),
    /onnx died/,
  );
  for (const sample of samples) {
    assert.equal(sample.signature.reid, undefined, 'nothing is written unless everything succeeded');
  }
});

test('progress is reported per frame, and counts up to the real total', async () => {
  const samples = fixture();
  const progress = [];
  await attachSampleReid(samples, {
    embed: embedByName,
    yieldTo: nextTick,
    onProgress: (done, total) => progress.push([done, total]),
  });

  assert.deepEqual(progress[0], [0, 9], 'the counter appears before any work, so it is never blank');
  assert.deepEqual(progress.at(-1), [9, 9]);
  assert.deepEqual(
    progress.map(([done]) => done),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    'it moves one frame at a time, so it never jumps or sticks',
  );
});

test('an empty selection is a no-op, not a crash', async () => {
  assert.equal(await attachSampleReid([], { embed: embedByName, yieldTo: nextTick }), true);
});

test('averageReidVectors matches identify.js averageVectors: mean then L2 normalise', () => {
  assert.deepEqual(averageReidVectors([[0.6, 0.8]]), [0.6, 0.8], 'one vector passes through untouched');
  const avg = averageReidVectors([
    [1, 0],
    [0, 1],
  ]);
  assert.ok(Math.abs(avg[0] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(avg[1] - Math.SQRT1_2) < 1e-12);
  assert.deepEqual(averageReidVectors([[], []]), [], 'nothing to average');
  // A ragged or non-finite entry must not produce NaN in a gallery.
  const ragged = averageReidVectors([[1, 0, 0], [0, Number.NaN]]);
  assert.ok(ragged.every((v) => Number.isFinite(v)));
});
