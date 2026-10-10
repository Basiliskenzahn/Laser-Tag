# The `shape` feature is inert — a bug report

One of the four colour-path identification features does not work. It scores **0 for the correct
person**, which means the guard built on it rejects every colour-only match it is asked about, and
the evidence accumulator never fills through that path.

This is written up separately from the [audit](detection-pipeline-audit.md) because it needs a
**tuning decision** before any code moves, and because the failure is silent: nothing throws,
nothing logs, and the feature appears to be working in the one test that covers it.

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

## What breaks as a result

Only the **colour-only path** is affected — when re-identification decides, `rejectionReason()`
skips the per-part floors entirely, by design. But on that path:

1. **`MIN_SHAPE_SCORE = 0.36` can never be met**, so `rejectionReason()` returns `'shape'` for
   every candidate that gets that far.
2. **`EVIDENCE_MIN_PART = 0.24` can never be met either**, so `evidenceWeight()` returns 0 for
   every check — the leaky-bucket evidence accumulator **never fills at all** in colour-only mode.
3. `softLabelMatch()` applies the same floor, so near-misses cannot become candidates either.

So in colour-only mode, identification does not run through the careful evidence-and-hysteresis
path it was designed to use. It survives on two fallbacks:

- **closed-set forced accept** — `matchGallery()` with `closedSet: true` returns the best match
  regardless of the gates, and the game always passes `closedSet: true`
- the **`INITIAL_STREAK` fast lock** — two agreeing checks name a brand-new track

Which is a plausible contributor to the over-classification that drove the whole OSNet effort:
colour-only matching was running with one of its four guards disabled *and* with its evidence
damping inert, leaving forced-accept doing the work.

## Why the tests do not catch it

`test/reid-matching.test.js` hand-builds galleries with **raw** `shape` values on both sides:

```js
shape: [2.5, 0.5]
```

Both sides raw means `shapeSimilarity()` returns ~1 and the feature looks healthy. The bug only
appears when one side has been through `averageSignatures()` — which is exactly what production
does and the test does not.

That is the same class of blind spot found in `test/motion.test.js`, which feeds boxes
**unsmoothed** and so had always validated a path production did not run.

## Fixing it — and why it is a decision, not a patch

Three options, none free:

| Option | Effect | Cost |
| --- | --- | --- |
| **A. Stop normalising `shape` in `averageSignatures()`** | Both sides raw; `shapeSimilarity()` works as written | Smallest diff. But `averageVectors()` is shared by every field, so `shape` needs its own averaging path |
| **B. Make `shapeSimilarity()` scale-invariant** | Compares shape regardless of normalisation | Changes what the feature *means* — a ratio of ratios is no longer "same proportions" |
| **C. Normalise the live side too** | Both sides normalised | Discards the magnitude, which is the part that detects partial bodies — defeats the point |

**A is most likely right**, but whichever is chosen, **the thresholds have to be retuned with
it**, because today they are effectively unreachable and the matcher has been tuned *around* their
absence:

- `MIN_SHAPE_SCORE` (0.36) has never actually gated anything. Its real-world distribution is
  unknown.
- `EVIDENCE_MIN_PART` (0.24) is currently blocking all colour-path evidence. Turning that on
  changes identification dynamics across the board, not just `shape`.
- The closed-set forced-accept path has been carrying the load. Restoring the guard may make
  colour-only *more* conservative — likely desirable, since it over-accepts, but it is a
  behavioural change to a gameplay-critical path.

So the fix is one or two lines; the **validation** is the work. It cannot be verified from the
armchair, because what it changes is precisely the distribution of scores nobody has measured.

## Recommended sequence

1. **Add a test that reproduces it** — one live signature against its own `averageSignatures()`
   output, asserting `shapeSimilarity` ≈ 1. It should fail today. This is the cheap, safe step and
   is worth doing even if the fix is deferred.
2. **Fix the scale** (option A), leaving the thresholds alone for the moment.
3. **Measure the resulting distribution** with `?debug`, which already prints the per-part scores
   (`u`/`l`/`g`/`s`) for every identified and rejected track. Collect real values for `s` with
   colour-only matching forced — most easily by running on a phone where re-identification does
   not load, or against galleries scanned before OSNet existed.
4. **Set `MIN_SHAPE_SCORE` and `EVIDENCE_MIN_PART` from those numbers**, not from the current
   values, which were chosen against a feature that was returning zero.

## Priority

**Low urgency, non-trivial value.** Re-identification overrides the colour path whenever it
loads, so most phones in most games never touch the affected code. It matters for: a phone where
OSNet fails to load, a gallery scanned before OSNet existed, and anyone reasoning about why
colour-only over-accepts.

It is recorded as open in [Streamlining](streamlining.md) and in the
[audit](detection-pipeline-audit.md).
