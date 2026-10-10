// Turning 40-60 usable recorded frames into a compact, varied gallery of 12-24 angles
// (`screens/scan.js` records the frames and describes them; this decides which descriptions
// survive and what each surviving sample is made of).
//
// It lives on its own because it is the one phase of a scan with no camera, no canvas and no
// inference in it - pure arithmetic over signatures - so a test can drive it with signatures it
// chose and no DOM at all (`test/scan-select.test.js`). It was extracted when `screens/scan.js`
// could not be imported under Node; test/helpers/fake-dom.js has since removed that excuse, so
// the reason it is still here is the narrower one: selection is where a change quietly alters
// what a player's gallery contains for the rest of the round, and this is the only way to pin it
// against a reference implementation rather than against a whole scan.
//
// Every threshold is passed in rather than imported, so the scan's tuning stays in one place at
// the top of `screens/scan.js` - and so a test can choose its own numbers instead of asserting a
// constant against itself.
//
// Two things about the shape of this pass:
//
//   * **Nothing here can see `reid`.** `signatureSimilarity` averages `hist`, `lower` and `grid`
//     and nothing else, deliberately: this step is about telling *different views of one person*
//     apart, and a model trained to be view-invariant would rate every angle alike and defeat the
//     diversity selection. It is also what makes deferring the OSNet pass until after selection
//     safe (see scan-reid.js).
//   * **It yields.** Selection used to run to completion in a single task - tens of thousands of
//     similarity computations between two `performance.now()` calls - so the progress line froze
//     and the ✕ did nothing for as long as it took. Every loop now reports the work it did to a
//     `tick` and the renderer gets a turn when enough has gone by.

import { averageSignatures } from './identify.js';

// How much work may happen between renderer yields, in similarity computations. One comparison is
// three cosines over 64-to-192-element vectors, so a few thousand of them is a few milliseconds:
// short enough that the ✕ responds within a frame, long enough that the yields - a whole renderer
// frame each - do not dominate the pass.
export const SCAN_SELECT_YIELD_WORK = 4_000;

// Yields to the renderer once `budget` units of work have been reported. Each loop hands it the
// number of comparisons it just did, so one shape of yielder serves loops with very different
// per-iteration costs.
export function cooperativeTicker(yieldTo, budget = SCAN_SELECT_YIELD_WORK) {
  let used = 0;
  return async (work = 1) => {
    used += work;
    if (used < budget) return;
    used = 0;
    await yieldTo();
  };
}

// Byte-for-byte what identify.js's private `cosine` does. It is duplicated rather than shared
// because identify.js does not export it; the risk of a duplicate is one copy gaining a guard the
// other does not, so if you change either, change both.
export function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

export function signatureSimilarity(a, b) {
  return (cosine(a?.hist, b?.hist) + cosine(a?.lower, b?.lower) + cosine(a?.grid, b?.grid)) / 3;
}

// Usually a different person who wandered through the shot, or a badly placed box: a frame whose
// four nearest neighbours do not look much like it. Abandoned rather than applied if it would
// leave too few frames to enrol.
export async function removeScanOutliers(candidates, { minSamples, outlierSimilarity, tick }) {
  if (candidates.length <= minSamples) return candidates;
  const scored = [];
  for (const candidate of candidates) {
    const neighbors = candidates
      .filter((other) => other !== candidate)
      .map((other) => signatureSimilarity(candidate.signature, other.signature))
      .sort((a, b) => b - a)
      .slice(0, 4);
    const neighborScore = neighbors.reduce((sum, value) => sum + value, 0) / Math.max(1, neighbors.length);
    scored.push({ ...candidate, neighborScore });
    await tick(candidates.length);
  }
  const kept = scored.filter((candidate) => candidate.neighborScore >= outlierSimilarity);
  return kept.length >= minSamples ? kept : scored.sort((a, b) => b.quality - a.quality).slice(0, minSamples);
}

// Best-quality-first, keeping a frame only if it is not all but identical to one already kept.
export async function removeScanDuplicates(candidates, { minSamples, duplicateSimilarity, tick }) {
  const kept = [];
  for (const candidate of [...candidates].sort((a, b) => b.quality - a.quality)) {
    if (kept.every((sample) => signatureSimilarity(candidate.signature, sample.signature) < duplicateSimilarity)) {
      kept.push(candidate);
    }
    await tick(kept.length);
  }
  return kept.length >= minSamples ? kept : candidates;
}

// One gallery sample: the seed averaged with the frames that look most like it, which smooths out
// per-frame sensor noise without blurring two different angles together.
//
// The seed is always in its own average. It used to be ranked alongside the others on
// `similarity + quality * 0.05` and then cut by the slice, so four better-scoring candidates could
// push it out of the group - while the sample still spread `...seed` over itself and kept the
// seed's frame and box, which is what the re-identification pass then embeds and what a thumbnail
// would show. A sample whose own seed frame is not in its signature is not what any of its callers
// assume. Ranking only the others and prepending the seed keeps the group and its provenance the
// same thing.
export function averagedRotationSample(seed, candidates, { viewAverageSimilarity, averageCount }) {
  const others = candidates
    .filter((candidate) => candidate !== seed)
    .map((candidate) => ({ candidate, similarity: signatureSimilarity(seed.signature, candidate.signature) }))
    .filter((entry) => entry.similarity >= viewAverageSimilarity)
    .sort((a, b) => b.similarity + b.candidate.quality * 0.05 - (a.similarity + a.candidate.quality * 0.05))
    .slice(0, averageCount - 1)
    .map((entry) => entry.candidate);
  const neighbors = [seed, ...others];
  return {
    ...seed,
    signature: averageSignatures(neighbors.map((candidate) => candidate.signature)),
    quality: neighbors.reduce((sum, candidate) => sum + candidate.quality, 0) / neighbors.length,
    // The frames this sample was averaged from, so attachSampleReid can embed exactly them and
    // average the result the same way. Never reaches the gallery: only `signature` does.
    sources: neighbors,
  };
}

// Greedily pick `targetCount` seeds, each time taking the candidate with the best
// `quality + (1 - closest similarity to an already-picked seed) * diversityWeight`. So a slightly
// worse frame of an angle nobody has yet beats a great frame of an angle already covered.
//
// `nearest` is carried forward rather than recomputed. It used to be re-derived from scratch for
// every candidate on every iteration - pool x selected comparisons each time, ~34 k of them over
// 24 iterations with 60 candidates, and the single biggest reason the ✕ was unresponsive - and the
// result was always exactly the previous iteration's value max'd against the seed just taken. So
// that is what it is now: one comparison per surviving candidate per iteration, ~1.4 k instead of
// ~34 k, choosing the same seeds in the same order. The entries move with their candidate when the
// pool is spliced, so even the first-index tie-break is unchanged.
export async function selectDiverseRotationSeeds(candidates, targetCount, { diversityWeight, tick }) {
  const pool = [...candidates].sort((a, b) => b.quality - a.quality).map((candidate) => ({ candidate, nearest: 0 }));
  const selected = [];
  while (pool.length && selected.length < targetCount) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const score = pool[i].candidate.quality + (1 - pool[i].nearest) * diversityWeight;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    const seed = pool.splice(bestIndex, 1)[0].candidate;
    selected.push(seed);
    for (const entry of pool) {
      entry.nearest = Math.max(entry.nearest, signatureSimilarity(entry.candidate.signature, seed.signature));
    }
    await tick(pool.length);
  }
  return selected;
}

// The whole pass. Resolves null when the scan was cancelled part-way through - the same contract
// the recording and processing loops have, so a cancel during selection can never leave a
// half-selected gallery behind, and a superseded run stops burning the phone's one thread on a
// gallery its caller is going to discard.
//
// Note the asymmetry it can produce: with `targetCount` or fewer clean candidates every sample is
// a single frame and `sources` is absent; with more, every sample is an average of up to
// `averageCount`. Both are valid galleries, and scan-reid.js copes with both.
//
// There used to be a final ordering step here (`orderRotationSamplesByView`), which walked the
// samples into the order the player had turned in. Nothing read that order: matching scores every
// sample and sorts by score (`bestAngleScore` in identify.js), and the server stores the array as
// it arrives. Its one consumer had been a thumbnail strip that no longer exists, so it was 20
// lines of similarity arithmetic, a renderer yield per sample, and the only reader of each
// candidate's `time` - all of it to permute an array nobody looks at.
export async function selectRotationSamples(candidates, options) {
  const { targetCount, yieldTo, cancelled = () => false } = options;
  const tick = cooperativeTicker(yieldTo);
  const steps = { ...options, tick };
  const clean = await removeScanDuplicates(await removeScanOutliers(candidates, steps), steps);
  if (cancelled()) return null;
  if (clean.length <= targetCount) return clean;
  // At most `targetCount` seeds, so at most `targetCount` samples: the pass used to re-slice to
  // the target here, which could never remove anything.
  const seeds = await selectDiverseRotationSeeds(clean, targetCount, steps);
  if (cancelled()) return null;
  const samples = [];
  for (const seed of seeds) {
    samples.push(averagedRotationSample(seed, clean, steps));
    await tick(clean.length);
  }
  return cancelled() ? null : samples;
}
