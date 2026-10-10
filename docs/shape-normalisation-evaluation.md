# `shape` normalisation — evaluation

What correcting the `shape` signature ([bug report](shape-feature-bug.md)) does to colour-only
identification, measured against the production matcher.

> ## This is synthetic, not phone footage
>
> This repository has no labelled recordings of real players, and nothing below was recorded on a
> device. The population is **generated**: flat coloured bands standing in for clothing, and a
> seeded pseudo-random walk standing in for distance, viewing angle and lighting.
>
> What is real is the code under test. `tools/shape-evaluation.mjs` calls
> `extractSignature()` → `averageSignatures()` → `matchGallery()` in `frontend/public/identify.js`
> unmodified, through a canvas stub that resamples the synthetic frame the way `drawImage` would.
> Every number here came out of a run that actually happened and can be reproduced exactly.
>
> So these figures bound the **direction** and rough **shape** of the change. They are not an
> accuracy measurement, and in particular they are **not** sufficient to choose a threshold. The
> audit's distinction between [measured and simulated](detection-pipeline-audit.md) applies: this
> is squarely in the simulated column, like the motion-matching figures and unlike the OSNet ones.

## Reproducing it

```
npm run eval:shape                            # seed 20251010, the run below
node tools/shape-evaluation.mjs --seed 7      # any other seed
node tools/shape-evaluation.mjs --json        # the same numbers, machine-readable
```

Deliberately **not** part of `npm test`: it is an instrument, not a regression gate. The
regression gate for the fix is `test/shape-signature.test.js`, which does run under `npm test`.

## What was run

| | |
| --- | --- |
| Seed | `20251010` |
| Frame | 640 × 480 |
| Population | 4 enrolled players + 6 bystanders |
| Enrolment | 4 gallery entries per player, each averaged over 6 samples at 0.55–0.70 frame height |
| Live sightings | 60 per person (600 total), at 0.22–0.92 frame height |
| Partial-body sightings | 30 per enrolled player (120 total), top 45% of the body only |
| Body aspects | drawn per person from 1.85–3.3; detector box slop ±4% per sighting |
| Variation per sighting | lighting gain 0.70–1.25, clothing hue drift ±12°, pixel noise, random viewing angle |
| Path forced | **colour-only** — no `reid`, no `embed`, so `similarityParts()` takes the last branch of its fallback chain |
| Decision | `matchGallery(..., { includeRejected: true })`, open set, so the per-part gates actually apply |

Each live sighting is scored **twice against the same fixtures**:

- **legacy** — the gallery entries with `shape` L2-normalised, i.e. the bug
- **fixed** — the gallery entries as the current code builds them, `shape` averaged raw

so every difference below is attributable to that one line and nothing else.

## Results (seed 20251010)

### Per-check decisions

| | legacy (bug) | fixed |
| --- | --- | --- |
| correct-player acceptance | 0.0% | **92.1%** |
| wrong-player acceptance | 0.0% | 0.0% |
| unresolved (player seen, nobody named) | 100.0% | 7.9% |
| bystander acceptance | 0.0% | 4.2% |
| partial body of a player accepted anyway | 0.0% | 0.0% |
| partial body rejected *by the `shape` gate* | 3.3% | 3.3% |
| partial body refused by `boxQuality` before any feature ran | 22.5% | 22.5% |
| correct pairs clearing `EVIDENCE_MIN_PART` on all four parts | 0.0% | **98.8%** |
| correct pairs with a non-zero `evidenceWeight()` | 0.0% | **98.8%** |
| correct pairs falling under `MIN_SHAPE_SCORE` (0.36) | 100.0% | 0.0% |

Rejection reasons, 600 full-body sightings:

| | legacy | fixed |
| --- | --- | --- |
| accepted | 0 | 236 |
| `score` | 335 | 288 |
| `shape` | 226 | 0 |
| `upper` | 23 | 42 |
| `lower` | 16 | 34 |

### Empirical `shape` score distribution

| pairs | n | min | p05 | p10 | p25 | median | p75 | p90 | p95 | max | exactly 0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| legacy, correct person | 240 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 100.0% |
| legacy, wrong person | 2160 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 100.0% |
| **fixed, correct person** | 240 | 0.922 | 0.942 | 0.951 | 0.962 | 0.975 | 0.987 | 0.996 | 0.998 | 1.000 | 0.0% |
| **fixed, wrong person** | 2160 | 0.443 | 0.559 | 0.624 | 0.718 | 0.853 | 0.933 | 0.970 | 0.986 | 1.000 | 0.0% |
| fixed, correct person, partial body | 93 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.010 | 0.032 | 0.037 | 0.059 | 65.6% |

The legacy rows are the bug in one line: **every** `shape` comparison returned exactly 0, for the
correct person and the wrong one alike. The gallery value had become a constant
`1 / sqrt(1 + (vw/vh)²)` — 0.600 in a 4:3 frame — carrying no information about the person at all,
because `shape`'s second component is just the aspect times the frame's own aspect ratio and the
L2 divisor therefore cancelled the aspect out.

### Where a threshold could go (fixed feature)

| gate | correct pairs rejected | wrong-person pairs rejected |
| --- | --- | --- |
| 0.24 (`EVIDENCE_MIN_PART`) | 0.0% | 0.0% |
| 0.30 | 0.0% | 0.0% |
| **0.36 (`MIN_SHAPE_SCORE`, current)** | **0.0%** | **0.0%** |
| 0.45 | 0.0% | 0.1% |
| 0.55 | 0.0% | 4.4% |
| 0.65 | 0.0% | 13.3% |
| 0.75 | 0.0% | 32.0% |
| 0.85 | 0.0% | 48.9% |
| 0.90 | 0.0% | 62.9% |

**Read the high gates with suspicion.** These fixtures give the same person the same body aspect
by construction, varied only by ±4% of box slop, so the correct-person column is unrealistically
tight. Real clothing (a coat changes a box's width), pose, partial occlusion and detector
variability spread it much further, and that spread is exactly the quantity nobody has measured.
The table says where a threshold *could* sit on synthetic data; it is not evidence about a phone.

### Stability across seeds

Three extra seeds, to show the pattern is not one lucky population:

| seed | correct acceptance (legacy → fixed) | bystander acceptance (fixed) | correct-pair `shape` min | wrong-person `shape` median | correct pairs under 0.36 |
| --- | --- | --- | --- | --- | --- |
| 20251010 | 0.0% → 92.1% | 4.2% | 0.922 | 0.853 | 0.0% |
| 7 | 0.0% → 89.6% | 1.9% | 0.931 | 0.737 | 0.0% |
| 99 | 0.0% → 87.9% | 6.4% | 0.925 | 0.789 | 0.0% |

Wrong-player acceptance was 0.0% on every seed, and `EVIDENCE_MIN_PART` reachability on correct
pairs went 0.0% → 95.8–98.8%.

## What this says

1. **The functional change is the evidence accumulator, not the gate.** The headline is not that
   `shape` now scores ~1 for the right person; it is that `evidenceWeight()` returns something
   other than zero on the colour path for the first time. `EVIDENCE_MIN_PART` applies to all four
   colour parts, so a permanently-zero `shape` meant **no colour-only check ever counted as
   evidence at all**. The leaky-bucket logic the tracker is built around was dead code on that
   path; it now runs.
2. **The gate at 0.36 is reachable and costs nothing here.** 0% of correct pairs fall under it on
   every seed, with the nearest correct pair at 0.922 — a very wide margin. It also catches
   essentially nothing: 0.0–1.1% of wrong-person pairs. On this population the corrected gate is
   harmless but near-inert as a discriminator between *people*.
3. **It is not inert for its actual job.** `shape` was documented as a guard against partial
   bodies and odd framing, not as a way of telling people apart, and that is what the partial-body
   row shows: the correct player's own half-body box scores a median of 0.000 against their own
   gallery. Most such boxes are already refused by `boxQuality` (22.5%) or fail on `score`, so
   `shape` was the deciding reason on only 3.3% of them here — but it is the only feature that
   objects to them in principle, and the synthetic partial bodies are cruder than real occlusion.
4. **The embedder path changed too, by a bounded amount.** The original bug report says only the
   colour-only path is affected. That is wrong: `rejectionReason()` and `evidenceWeight()` skip
   the per-part floors only when `hasReid`, so the MobileNet-embedding path (signal 2) carried the
   dead `shape` gate as well. Its blend spends `EMBED_SHAPE_WEIGHT = 0.06` on `shape`, so a
   correct match on that path gains up to +0.06 of score and stops being rejected for `shape`.
   Pinned down in `test/shape-signature.test.js`.
5. **The re-identification path is untouched**, which is the important safety property, since
   that is the path nearly every real game takes. `similarityParts()` returns `reid` as the score
   outright when both sides carry an embedding, and `rejectionReason()` short-circuits on
   `hasReid` before any per-part floor. Asserted directly: replacing a gallery entry's `shape`
   with `[0.004, 900]` leaves the re-id score, the accept decision and the rejection reason bit
   for bit identical.

## Recommendation — **not applied**

> Nothing in this section has been changed in code. `MIN_SHAPE_SCORE` is still 0.36 and
> `EVIDENCE_MIN_PART` is still 0.24, per the repo owner's instruction to defer threshold
> recalibration until a replay evaluation on real examples.

- **Keep `MIN_SHAPE_SCORE` at 0.36.** It now has a non-trivial margin above the worst correct
  pair measured here (0.922) and rejects no correct player on any seed, so leaving it is the safe
  landing: the feature is corrected and the gate is *reachable* without becoming a new way to lose
  a player. Raising it towards the 0.75–0.90 range where it would start discriminating between
  people is where the risk lives, and the synthetic correct-person spread is far too narrow to
  justify that. **Do not raise it without real colour-only score distributions.**
- **Keep `EVIDENCE_MIN_PART` at 0.24.** Correct pairs clear it 95.8–98.8% of the time, so the
  accumulator works rather than merely unblocking. But this is the change with the widest reach —
  it turns on a code path that has never run in production on the colour-only route — and the
  right check on it is a real game on a phone where OSNet does not load, not more fixtures.
- **Treat `shape` as a guard, not a discriminator.** If a future tuning round wants it to separate
  *people*, that is a different feature: body aspect overlaps heavily between adults, which the
  wrong-person distribution above already shows (median 0.853). The honest use of a higher gate
  would be as a partial-body/framing check.

### How to confirm on real hardware

`?debug` already prints the per-part scores (`u`/`l`/`g`/`s`) for every identified and rejected
track (see [debug mode](development/debug-mode.md)). Colour-only matching has to be forced to see
them: run on a device where OSNet does not load, or against galleries scanned before OSNet
existed. Collect `s` for known-correct and known-wrong pairs and compare against the fixed rows
above. If the real correct-pair distribution reaches down near 0.36, the gate must be lowered or
stop being a hard rejection criterion; if it sits as high as the synthetic one, raising it becomes
arguable.

## Related

- [The `shape` feature is inert — a bug report](shape-feature-bug.md) — the diagnosis, and the fix
- [Detection pipeline audit](detection-pipeline-audit.md) — the measured-vs-simulated accounting
  this document files itself under
- [Configuration](development/configuration.md) — where the two constants live
