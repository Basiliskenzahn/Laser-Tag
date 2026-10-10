# The `shape` feature was inert — a bug report

> **Fixed** on `luxkaiwalker/shape-normalisation`. `shape` is now averaged raw instead of being
> L2-normalised, so a live signature and its own gallery entry are on the same scale. The
> thresholds built on it, `MIN_SHAPE_SCORE` and `EVIDENCE_MIN_PART`, are **deliberately unchanged**:
> the fix makes them reachable rather than retuning them, because picking new numbers needs real
> colour-only score distributions that still do not exist. Measurements against the corrected
> feature are in [the evaluation](shape-normalisation-evaluation.md) — synthetic, not phone
> footage. See [The fix](#the-fix) at the bottom; everything above it is the original diagnosis,
> kept because the *shape* of the failure is the useful part.

One of the four colour-path identification features did not work. It scored **0 for the correct
person**, which meant the guard built on it rejected every colour-only match it was asked about,
and the evidence accumulator never filled through that path.

This was written up separately from the [audit](detection-pipeline-audit.md) because it needed a
**tuning decision** before any code moved, and because the failure was silent: nothing threw,
nothing logged, and the feature appeared to be working in the one test that covered it.

## What `shape` is for

`shapeSignature()` returns two numbers describing a person box's proportions:

```js
function shapeSignature(source, box) {
  const { aspect, heightRatio, widthRatio } = boxMetrics(source, box);
  return [aspect, heightRatio / Math.max(widthRatio, 0.001)];
}
```

Its job is as a **guard, not an identifier** — it rejects partial bodies and wildly different
pose/framing without depending on how far away the person is standing. It carries the smallest
weight of the four colour features (`SHAPE_WEIGHT = 0.1`) but has a hard floor,
`MIN_SHAPE_SCORE = 0.36`, which a match must clear to be accepted at all.

## The bug

**Live signatures keep the raw values. Gallery entries do not.**

Every gallery entry is produced by `averageSignatures()`, which routes each field — including
`shape` — through `averageVectors()`:

```js
return normalize(avg.map((v) => v / vectors.length));
```

`normalize()` is L2 normalisation. So a gallery `shape` is a **unit vector**, while the live
`shape` it is compared against is a **raw magnitude**. And `shapeSimilarity()` compares them
directly, as a ratio:

```js
return Math.max(0, 1 - Math.abs(Math.log(aspectA / aspectB)) / Math.log(2.2));
```

That is the only comparison in `identify.js` that is **not scale-invariant**. Every other feature
is compared with `cosine()`, which normalises internally and therefore cannot notice the
difference. `shape` can, and does.

### Worked example

A typical 80 × 180 px box in a 640 × 480 frame, matched against *the same person's own gallery
entry*:

| | value |
| --- | --- |
| live `shape` (raw) | `[2.250, 3.000]` |
| gallery `shape` (L2-normalised) | `[0.600, 0.800]` |
| `shapeSimilarity()` | **0** |
| what it should be | ~1 |

`log(2.25 / 0.6) = 1.32`, divided by `log(2.2) = 0.79`, gives 1.67; `1 - 1.67` is negative, so
the `Math.max(0, …)` floors it at zero.

### The 0.600 is not a coincidence

Noticed while fixing it, and it makes the defect worse than described above. `shape`'s second
component is `heightRatio / widthRatio` = `(h/vh) / (w/vw)` = **aspect × (vw/vh)**. The two
components are therefore *collinear*: `[a, a·r]` for a frame of aspect `r`. L2-normalising that
gives `[1/√(1+r²), r/√(1+r²)]` — a constant, with the aspect cancelled clean out. Every enrolled
person's gallery `shape[0]` was the same number: **0.600 in any 4:3 frame**, 0.490 in 16:9.

So the gallery side of the comparison carried no information about the person at all, and the
score reduced to a function of the live aspect alone, non-zero only for a live aspect between
0.273 and 1.32. A standing person's box is 1.9–3.3. The 100%-zero column in the
[evaluation](shape-normalisation-evaluation.md) is this.

It also means component 1 is pure redundancy: `shapeSimilarity()` reads only index 0, and index 1
is a fixed multiple of it. It is kept in the vector because the stored format and
`bestAngleScore()`'s non-empty check both expect two numbers.

## What breaks as a result

**Correction to the original report.** This section said only the colour-only path was affected.
That is wrong. `rejectionReason()` and `evidenceWeight()` skip the per-part floors only when
`hasReid` — so the **MobileNet-embedding path** (signal 2) carried the dead `shape` gate too, and
spent `EMBED_SHAPE_WEIGHT = 0.06` of its blend on a feature returning zero. The re-identification
path is the only one genuinely immune, which is also the one nearly every real game takes. On
both affected paths:

1. **`MIN_SHAPE_SCORE = 0.36` can never be met**, so `rejectionReason()` returns `'shape'` for
   every candidate that gets that far.
2. **`EVIDENCE_MIN_PART = 0.24` can never be met either**, so `evidenceWeight()` returns 0 for
   every check — the leaky-bucket evidence accumulator **never fills at all** on those paths.
3. `softLabelMatch()` applies the same floor, so near-misses cannot become candidates either.

So without re-identification, identification does not run through the careful
evidence-and-hysteresis path it was designed to use. It survives on two fallbacks:

- **closed-set forced accept** — `matchGallery()` with `closedSet: true` returns the best match
  regardless of the gates, and the game always passes `closedSet: true`
- the **`INITIAL_STREAK` fast lock** — two agreeing checks name a brand-new track

Which is a plausible contributor to the over-classification that drove the whole OSNet effort:
colour-only matching was running with one of its four guards disabled *and* with its evidence
damping inert, leaving forced-accept doing the work.

## Why the tests did not catch it

`test/reid-matching.test.js` hand-builds galleries with **raw** `shape` values on both sides:

```js
shape: [2.5, 0.5]
```

Both sides raw means `shapeSimilarity()` returns ~1 and the feature looks healthy. The bug only
appears when one side has been through `averageSignatures()` — which is exactly what production
does and the test does not.

That is the same class of blind spot found in `test/motion.test.js`, which feeds boxes
**unsmoothed** and so had always validated a path production did not run.

## The options that were on the table

| Option | Effect | Cost |
| --- | --- | --- |
| **A. Stop normalising `shape` in `averageSignatures()`** | Both sides raw; `shapeSimilarity()` works as written | Smallest diff. But `averageVectors()` is shared by every field, so `shape` needs its own averaging path |
| **B. Make `shapeSimilarity()` scale-invariant** | Compares shape regardless of normalisation | Changes what the feature *means* — a ratio of ratios is no longer "same proportions" |
| **C. Normalise the live side too** | Both sides normalised | Discards the magnitude, which is the part that detects partial bodies — defeats the point |

## The fix

**Option A.** `shape` is averaged with a plain component-wise mean; everything else keeps the
normalised one:

```js
function meanVector(vectors) { /* component-wise mean, no normalisation */ }
function averageVectors(vectors) { return normalize(meanVector(vectors)); }

export function averageSignatures(signatures) {
  return {
    hist: averageVectors(signatures.map((s) => s.hist)),
    // ...
    shape: meanVector(signatures.map((s) => s.shape)),
  };
}
```

`averageVectors()` itself is untouched. `hist`, `lower`, `grid`, `embed` and `reid` are all
compared with `cosine()`, which divides by the magnitudes anyway, so normalising them is free and
keeps stored vectors on a uniform scale — in the join message, in the cache and on the wire.
`shape` is the sole exception, and now says so in a comment at both ends.

Option B was rejected on meaning, not on effort. `aspect / ‖v‖` is not an aspect ratio; a
scale-invariant comparison of two aspect ratios is a ratio of ratios, which no longer answers "are
these the same proportions". Option C discards the quantity the feature is made of.

**`SCAN_CACHE_VERSION` 11 → 12.** A cached version-11 gallery stores `shape` as a unit vector, and
the corrected comparison reads that as a wildly wrong aspect ratio — the exact silently-wrong case
[the version exists for](client/scanning.md#why-the-version-exists). Phones discard those caches
and rescan. Galleries arriving over the wire from a player still running an older build are not
versioned and would stay broken for that one player's `shape` part; nothing else about matching
them changes, and `backend/sanitize.py` accepts raw aspect values unchanged (`clean_vector` only
requires finite floats, capped at 8 for `shape`).

### Thresholds: deliberately not touched

`MIN_SHAPE_SCORE` stays at 0.36 and `EVIDENCE_MIN_PART` at 0.24. The fix makes them **reachable**;
retuning them is a separate decision that needs real distributions. Both constants now carry a
comment in `identify.js` saying so, so nobody "cleans up" the apparent slack.

### What now covers it

`test/shape-signature.test.js`, eight cases, driving the real
`extractSignature()` → `averageSignatures()` → `matchGallery()` path through a canvas stub
(`test/fixtures/synthetic-frame.mjs`) rather than around it. All eight fail if the old line is put
back; the 24 pre-existing tests pass either way, which is the blind spot described above.

### What it measured

[`docs/shape-normalisation-evaluation.md`](shape-normalisation-evaluation.md), from
`npm run eval:shape`. **Synthetic, not phone footage.** On the colour-only path, correct-player
acceptance went 0.0% → 92.1% and correct pairs with a non-zero `evidenceWeight()` went 0.0% →
98.8%, with wrong-player acceptance 0.0% throughout. At 0.36 the corrected gate rejects no correct
player — and catches no wrong one either, so it is reachable but near-inert as a discriminator
between *people*. Where it is decisive is the case it was built for: a partial body of the correct
player scores a median of 0.000 against their own gallery.

## Priority, as it was judged

**Low urgency, non-trivial value.** Re-identification overrides the colour path whenever it
loads, so most phones in most games never touch the affected code. It mattered for: a phone where
OSNet fails to load, a gallery scanned before OSNet existed, and anyone reasoning about why
colour-only over-accepts. The fix was taken because it is small and the feature's correctness is
independent of the tuning question — not because the path is hot.

Recorded as resolved-with-caveat in [Streamlining](streamlining.md), the
[audit](detection-pipeline-audit.md) and the [status report](pipeline-status-report.md); the
deferred threshold decision is the open item in [BRANCH.md](../BRANCH.md).
