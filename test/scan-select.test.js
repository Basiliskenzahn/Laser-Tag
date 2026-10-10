// Sample selection (frontend/public/scan-select.js): which recorded frames become the gallery,
// and what each sample is made of.
//
// Three things are worth testing directly here, and none of them could be before this pass moved
// out of the screen:
//
//   1. **It yields.** Selection is pure arithmetic, so it used to run to completion in a single
//      task - tens of thousands of similarity computations - and the progress line froze and the
//      X did nothing for however long that took on the phone.
//   2. **Carrying `nearest` forward chooses the same seeds.** The seed pass used to recompute
//      every (pool x selected) similarity on every iteration, ~34 k calls with 60 candidates.
//      Carrying the value forward is a 24x reduction, and it is only worth anything if it picks
//      exactly the same frames - which is what the reference implementation below checks.
//   3. **A seed is in its own sample.** It could be ranked out of its own average by four
//      better-scoring candidates while the sample still kept the seed's frame.
//
// Thresholds are passed in by the caller, so every number here is the test's own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  averagedRotationSample,
  cooperativeTicker,
  selectDiverseRotationSeeds,
  selectRotationSamples,
  signatureSimilarity,
} from '../frontend/public/scan-select.js';

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

/** A deterministic unit-ish vector, so two candidates built from different seeds differ. */
function vector(seed, length) {
  let s = (seed + 1) * 2_654_435_761;
  return Array.from({ length }, () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  });
}

/** One described frame, as processRotationVideo produces them. */
function candidate(i, { quality = 1 + ((i * 7) % 11) / 10 } = {}) {
  return {
    signature: { hist: vector(i, 8), lower: vector(i + 100, 8), grid: vector(i + 200, 12), shape: [2 + i / 100, 0.6] },
    box: { x: 0, y: 0, w: 10, h: 30 },
    image: `frame-${i}`,
    frameIndex: i,
    quality,
    time: i * 190,
    stats: { brightness: 0.5, contrast: 0.2, sharpness: 0.02 },
  };
}

const OPTIONS = {
  targetCount: 24,
  minSamples: 12,
  outlierSimilarity: 0.36,
  duplicateSimilarity: 0.992,
  viewAverageSimilarity: 0.74,
  averageCount: 4,
  diversityWeight: 0.42,
};

const pool = (n) => Array.from({ length: n }, (_, i) => candidate(i));

test('a ticker yields once a batch of work has gone by, and not before', async () => {
  let yields = 0;
  const tick = cooperativeTicker(async () => {
    yields++;
  }, 100);

  await tick(40);
  await tick(40);
  assert.equal(yields, 0, 'under budget, the renderer is not worth a whole frame');
  await tick(40);
  assert.equal(yields, 1);
  // The counter resets, so the next yield is another full batch away.
  await tick(99);
  assert.equal(yields, 1);
  await tick(1);
  assert.equal(yields, 2);
});

test('selection yields to the renderer, and yields more the more work there is', async () => {
  // The bug was zero yields for *any* candidate count, so what this pins is the scaling rather
  // than a particular number: the pass must hand the renderer a frame every so many comparisons,
  // which means a bigger pool gets proportionally more of them instead of one long block. A fixed
  // expected count would be a restatement of SCAN_SELECT_YIELD_WORK and the pass's own
  // arithmetic, which would assert nothing.
  const yieldsFor = async (size) => {
    let yields = 0;
    const samples = await selectRotationSamples(pool(size), {
      ...OPTIONS,
      yieldTo: async () => {
        yields++;
        await nextTick();
      },
    });
    assert.ok(samples?.length, `selection produced no gallery for ${size} candidates`);
    return yields;
  };

  const small = await yieldsFor(40);
  const large = await yieldsFor(120);
  assert.ok(small >= 1, `40 candidates produced ${small} yields`);
  assert.ok(large > small, `120 candidates produced ${large} yields, 40 produced ${small}`);
});

test('a cancel part-way through selection produces nothing, not a short gallery', async () => {
  let yields = 0;
  const samples = await selectRotationSamples(pool(60), {
    ...OPTIONS,
    yieldTo: async () => {
      yields++;
      await nextTick();
    },
    // The X, landing on the first yield - which is inside the outlier pass, the earliest point a
    // cancel can be noticed.
    cancelled: () => yields >= 1,
  });

  assert.equal(samples, null, 'a cancelled selection must return null rather than a partial gallery');
});

test('carrying `nearest` forward picks exactly the seeds recomputing it picked', async () => {
  // The reference is the implementation this replaced: for every candidate on every iteration,
  // re-derive the closest similarity to any already-picked seed from scratch.
  const reference = (candidates, targetCount, diversityWeight) => {
    const remaining = [...candidates].sort((a, b) => b.quality - a.quality);
    const selected = [];
    while (remaining.length && selected.length < targetCount) {
      let bestIndex = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const nearest = selected.length
          ? Math.max(...selected.map((sample) => signatureSimilarity(remaining[i].signature, sample.signature)))
          : 0;
        const score = remaining[i].quality + (1 - nearest) * diversityWeight;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }
      selected.push(remaining.splice(bestIndex, 1)[0]);
    }
    return selected;
  };

  for (const size of [5, 13, 30, 60]) {
    const candidates = pool(size);
    const fast = await selectDiverseRotationSeeds(candidates, 24, { diversityWeight: 0.42, tick: async () => {} });
    const slow = reference(candidates, 24, 0.42);
    assert.deepEqual(
      fast.map((sample) => sample.frameIndex),
      slow.map((sample) => sample.frameIndex),
      `the seeds chosen from ${size} candidates changed, including their order`,
    );
  }
});

test('a seed is always in its own sample, even when four candidates outrank it', async () => {
  // The sort key was `similarity + quality * 0.05`, and the seed's own similarity to itself is 1 -
  // so four candidates similar enough and good enough could score above `1 + seedQuality * 0.05`
  // and fill the slice, pushing the seed out of its own group. The sample kept the seed's frame
  // and box regardless, which is the frame the re-identification pass then embeds.
  const seed = { ...candidate(0, { quality: 0 }), image: 'seed-frame' };
  // Near-identical signatures, so every one of them clears viewAverageSimilarity against the seed,
  // with qualities high enough to beat the seed's sort key.
  const twins = Array.from({ length: 5 }, (_, i) => ({
    ...candidate(0, { quality: 20 + i }),
    frameIndex: i + 1,
    image: `twin-${i}`,
  }));

  const sample = averagedRotationSample(seed, [seed, ...twins], { viewAverageSimilarity: 0.74, averageCount: 4 });

  assert.ok(sample.sources.includes(seed), "the seed must be in its own sample's sources");
  assert.equal(sample.sources.length, 4, 'and the group is still averageCount frames');
  assert.equal(sample.image, 'seed-frame', 'the frame the sample carries is the seed frame');
  assert.ok(
    sample.sources.some((source) => source.image === sample.image),
    'the frame the sample carries has to be one of the frames in its signature',
  );
});

test('a sample is the average of its own sources and nothing else', async () => {
  const seed = candidate(0, { quality: 5 });
  const others = [candidate(0, { quality: 1 }), candidate(0, { quality: 2 })].map((other, i) => ({
    ...other,
    frameIndex: i + 1,
  }));
  const sample = averagedRotationSample(seed, [seed, ...others], { viewAverageSimilarity: 0.74, averageCount: 4 });

  assert.equal(sample.sourceCount, 3);
  assert.ok(Math.abs(sample.quality - (5 + 1 + 2) / 3) < 1e-12, 'quality is the group mean');
  // Identical signatures, so their normalised average is each of them.
  const expected = signatureSimilarity(sample.signature, seed.signature);
  assert.ok(Math.abs(expected - 1) < 1e-9, 'averaging identical signatures changes nothing');
});

test('a gallery is never longer than the target, and never reorders into duplicates', async () => {
  const samples = await selectRotationSamples(pool(60), { ...OPTIONS, yieldTo: nextTick });
  assert.ok(samples.length <= OPTIONS.targetCount, `${samples.length} samples exceeds the target`);
  assert.equal(new Set(samples.map((sample) => sample.frameIndex)).size, samples.length, 'no frame twice');
});

test('too few candidates to select from are passed through rather than dropped', async () => {
  const samples = await selectRotationSamples(pool(4), { ...OPTIONS, yieldTo: nextTick });
  assert.equal(samples.length, 4, 'a short scan is the caller’s problem to report, not selection’s to hide');
  assert.deepEqual(await selectRotationSamples([], { ...OPTIONS, yieldTo: nextTick }), []);
});
