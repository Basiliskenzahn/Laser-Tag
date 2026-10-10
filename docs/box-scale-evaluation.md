# Box scale and range — evaluation

What admitting smaller detection boxes would cost, measured against the production matcher — and,
more importantly, what that measurement is not able to tell us.

This is a **new document rather than a section of
[`shape` normalisation evaluation](shape-normalisation-evaluation.md)**, even though it comes out
of the same harness. That document has one narrative — what correcting the `shape` signature did —
and its caveats are about choosing a `shape` threshold. This one answers a different question, and
its headline is a *negative* result about the fixtures themselves. Folded together, each would
bury the other.

## The question

Live matching refuses any box under **18 % of frame height** (`MIN_MATCH_HEIGHT_RATIO`) inside
`boxQuality()`, before a single feature is scored. A player far enough away is therefore never
identified, however recognisable they are. Lowering that gate — or adding a lower "far floor" with
a re-identification-only path above it — is the cheap fix.

The risk is the one this project already has history with: every variant of that fix makes the
system more willing to put a name on a marginal box, and everything after PR #4 was a fight with
over-classification (there is a branch called `working-classifier-that-overclassifies`). So the
output that matters is **wrong-player and bystander acceptance as a function of box height
ratio**.

## The answer, up front

**The synthetic curve is flat, and that is a fact about the fixtures, not reassurance about
range.** Correct-player acceptance is 88–92 % and wrong-player acceptance is 0.0 % in *every*
bucket, from boxes 12 px wide to boxes 102 px wide. A flat-colour fixture has almost no detail to
lose, so shrinking its box loses almost nothing.

Do not quote the table below as evidence that admitting small boxes is safe. It is not that.

Three things the sweep *does* establish, none of which depend on the fixtures being realistic:

1. **The height gate is the entire binding constraint below itself.** "Gate refuses" is 100 % for
   every bucket under 0.18, players and bystanders alike. No feature is ever scored, so no amount
   of appearance quality can rescue a distant player today. **The current failure is a refusal,
   not a mis-identification** — which is what makes the `?debug` range readout
   ([debug mode](development/debug-mode.md#the-range-readout)) the measurement that decides the
   fix, since it can tell a refusal from a missing detection in the field.
2. **The matcher's arithmetic has no hidden scale dependence.** Feed it small boxes and every
   score behaves as it does with large ones. If lowering the gate goes wrong, it will go wrong
   because of the pixels, not because some similarity silently misbehaves on small input.
3. **The feature canvas stops caring about box size far below the gate.** The colour histograms
   are read back through an **18 × 24** canvas and the body grid through a **6 × 8** one. A box at
   the 0.18 gate is about 40 × 103 px: it is *downsampled* into those canvases, as is everything
   larger. Whatever 0.18 is protecting, it is not histogram resolution — undersampling does not
   begin until roughly 0.05 of frame height, three and a half times lower.

> ## This is synthetic, not phone footage
>
> Same fixtures as the [`shape` evaluation](shape-normalisation-evaluation.md): flat coloured
> bands standing in for clothing, a seeded pseudo-random walk standing in for viewing angle and
> lighting, and no recordings of real players anywhere in this repository. What is real is the
> code under test — `extractSignature()` → `matchGallery()` in `frontend/public/identify.js`,
> unmodified, through a canvas stub that resamples the synthetic frame the way `drawImage` would.
>
> For a *scale* sweep that caveat matters more than it does anywhere else in these docs, because
> holding a person's appearance constant while shrinking their box is precisely the assumption
> that distance breaks. See [What this cannot tell us](#what-this-cannot-tell-us). In the audit's
> [measured vs simulated](detection-pipeline-audit.md) split this is squarely simulated.

## Reproducing it

```
node tools/shape-evaluation.mjs --scale-sweep                    # seed 20251010, the run below
node tools/shape-evaluation.mjs --scale-sweep --json             # the same numbers, machine-readable
node tools/shape-evaluation.mjs --scale-sweep --seed 7           # another population
node tools/shape-evaluation.mjs --scale-sweep --floor 0.08       # a different assumed far floor
node tools/shape-evaluation.mjs --scale-sweep --sightings 3      # a quick look, NOT a result
```

Deliberately **not** part of `npm test`: an instrument, not a regression gate. What does run under
`npm test` is `test/shape-evaluation-smoke.test.js`, which asserts that the harness still runs and
returns a well-formed result — **shape, never values** — so the instrument cannot rot silently and
keep printing authoritative-looking tables. Pinning a number down there would turn every
legitimate retune into a false regression; numbers belong here, next to their seed.

## What was run

| | |
| --- | --- |
| Seed | `20251010` |
| Frame | 640 × 480 |
| Population | 4 enrolled players + 6 bystanders |
| Enrolment | 4 gallery entries per player, each averaged over 6 samples at 0.55–0.70 frame height — close and well lit, as `scan.js` asks for. Realistic, and unchanged across buckets: the gallery is always of a nearby person however far away the live sighting is. That asymmetry is the thing being measured. |
| Live sightings | 60 per person, per bucket, per fixture mode |
| Path forced | colour-only (no `reid`, no `embed`) — the weakest branch of `similarityParts()` |
| Height gate | 0.18, read from `identify.js` |
| Assumed far floor | 0.10 — **an assumption**, not a constant that exists. `--floor` changes it |

Every row is scored with the height gate **forced open** (`usable: true` on the signature), because
the question is what the matcher *would* decide about a box that small, not that today's code
refuses it. The "gate refuses" column is what today's code does, kept separate so the
counterfactual and the current behaviour are never confused. Nothing else in the pipeline is
touched.

`ideal` is the long-standing fixture: `paint` is an analytic function of position, so a box 12 px
wide is exactly as detailed as one 102 px wide. `sensor` snaps every read to the pixel lattice
(`sensorGrid` in `test/fixtures/synthetic-frame.mjs`), so a small box has only as many distinct
values as it has sensor pixels and its per-pixel noise cannot average away. The gap between the two
columns is the harness's own estimate of how much its optimism is worth.

## Acceptance by box height ratio

`⌄floor` is below the assumed far floor; `far` is the band between floor and gate.

| height ratio | fixture | median box | correct | wrong player | bystander | unresolved | gate refuses (player/bystander) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.05–0.08 ⌄floor | ideal | 12×31 | 90.0% | **0.0%** | 1.4% | 10.0% | 100.0% / 100.0% |
| 0.05–0.08 ⌄floor | sensor | 12×31 | 89.6% | **0.0%** | 0.3% | 10.4% | 100.0% / 100.0% |
| 0.08–0.10 ⌄floor | ideal | 17×43 | 89.2% | **0.0%** | 1.7% | 10.8% | 100.0% / 100.0% |
| 0.08–0.10 ⌄floor | sensor | 17×43 | 89.6% | **0.0%** | 0.6% | 10.4% | 100.0% / 100.0% |
| 0.10–0.13 far | ideal | 21×55 | 87.9% | **0.0%** | 0.3% | 12.1% | 100.0% / 100.0% |
| 0.10–0.13 far | sensor | 21×55 | 92.1% | **0.0%** | 0.8% | 7.9% | 100.0% / 100.0% |
| 0.13–0.18 far | ideal | 29×74 | 92.1% | **0.0%** | 0.8% | 7.9% | 100.0% / 100.0% |
| 0.13–0.18 far | sensor | 28×74 | 91.3% | **0.0%** | 0.8% | 8.8% | 100.0% / 100.0% |
| 0.18–0.25 | ideal | 40×103 | 91.3% | **0.0%** | 0.3% | 8.8% | 0.4% / 0.6% |
| 0.18–0.25 | sensor | 40×104 | 89.2% | **0.0%** | 1.1% | 10.8% | 0.0% / 0.3% |
| 0.25–0.40 | ideal | 61×157 | 89.2% | **0.0%** | 1.4% | 10.8% | 0.0% / 0.0% |
| 0.25–0.40 | sensor | 60×156 | 89.6% | **0.0%** | 0.8% | 10.4% | 0.0% / 0.0% |
| 0.40–0.70 | ideal | 102×264 | 91.7% | **0.0%** | 2.2% | 8.3% | 0.0% / 0.0% |
| 0.40–0.70 | sensor | 102×263 | 90.0% | **0.0%** | 1.4% | 10.0% | 0.0% / 0.0% |

The small non-zero figures in the 0.18–0.25 "gate refuses" column are an artefact of whole pixels,
not a surprise: a requested ratio of 0.1801 becomes a box 86 px tall, which is 0.17917 of a
480-pixel frame and so lands just under the gate. About 0.3 % of that bucket rounds down across
the line. Nothing to read into.

Seed 7 gives the same flat shape at a lower level (82.9–88.3 % correct across all seven buckets,
0.0 % wrong player throughout), so the flatness is a property of the fixtures and not of one
population.

## Score distribution (ideal fixture, p05 / median of correct pairs; median / p95 / max of wrong)

| height ratio | correct p05 | correct median | wrong median | wrong p95 | wrong max |
| --- | --- | --- | --- | --- | --- |
| 0.05–0.08 | 0.700 | 0.928 | 0.418 | 0.546 | 0.676 |
| 0.08–0.10 | 0.670 | 0.917 | 0.419 | 0.550 | 0.688 |
| 0.10–0.13 | 0.667 | 0.914 | 0.416 | 0.545 | 0.685 |
| 0.13–0.18 | 0.710 | 0.920 | 0.418 | 0.551 | 0.679 |
| 0.18–0.25 | 0.712 | 0.928 | 0.416 | 0.553 | 0.677 |
| 0.25–0.40 | 0.708 | 0.917 | 0.418 | 0.548 | 0.682 |
| 0.40–0.70 | 0.719 | 0.922 | 0.417 | 0.544 | 0.683 |

Flat to within noise in every column. The correct/wrong separation does not narrow as boxes shrink
— which, again, is the fixtures speaking, not the camera.

## What this cannot tell us

- **No optics and no sensor.** No motion blur, no atmospheric haze, no lens softness, no ISP or
  JPEG artefacts, no detector box getting sloppier at range. Those are exactly the mechanisms that
  degrade a distant crop in real life. The real curve is worse than every row above, by an amount
  nothing here measures.
- **`sensor` models one mechanism, loosely.** Pixel-lattice quantisation with nearest-neighbour
  replication, not a real resample — harsher in the high frequencies than bilinear, and no blur at
  all. Treat the ideal/sensor gap as a lower bound on how much the optimism matters, not as a
  correction for it. It comes out near zero here, which is again about the fixture having no
  texture to quantise: flat colour survives any resampling.
- **`shape` cannot degrade with distance here, by construction.** `shapeSignature()` is built from
  the box aspect, and these fixtures give each person a fixed aspect varied by only ±4 % of box
  slop. The sweep therefore says *nothing at all* about `shape` at range. On a phone it will
  degrade, because the detector's box gets less reliable as the person gets smaller.
- **The correct-person column is unrealistically tight**, for the reason the
  [`shape` evaluation](shape-normalisation-evaluation.md) already warns about — and the warning is
  *more* important here, not less. Holding appearance constant while shrinking the box is the
  assumption distance breaks.
- **The far floor is an assumption.** 0.10 is a placeholder; no such constant exists in
  `identify.js` yet. The bucket boundaries straddle it so the curve would show what it buys, if
  there were anything to show.

## So what should decide the fix

Labelled phone footage at known distances. This harness cannot substitute for it, and neither can
any amount of extra buckets.

Until there is some, the thing to use is the **`?debug` range readout**
([debug mode → the range readout](development/debug-mode.md#the-range-readout)). It answers the
question this sweep cannot: for the people actually in front of the camera, are we failing to
*detect* them or detecting and *refusing* them? Those have opposite fixes — a second
region-of-interest detection pass, costing up to half the detection cadence on a slow phone,
versus a gate change that costs nothing — and finding 0.0 % wrong-player acceptance on synthetic
fixtures is not grounds for picking either one.

## Related

- [`shape` normalisation evaluation](shape-normalisation-evaluation.md) — the same harness's other
  mode, and the source of the fixture caveats
- [Debug mode](development/debug-mode.md) — the on-device readout, including the range line
- [Detection pipeline audit](detection-pipeline-audit.md) — measured vs simulated across the
  pipeline
- [Identification](client/identification.md) — what the gates are and where they sit
