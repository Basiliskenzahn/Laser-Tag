# Detection pipeline audit — what decides who you shot

A per-feature audit of the identification pipeline: what each signal costs, how accurate it
actually is, and — the part that matters most — **which of those accuracy numbers are measured
and which are simulated.**

> **Snapshot, and partly superseded.** This was written against `dev` before the model warm-up
> landed and before the `detection-tuning` work existed. Two things have changed since and are
> *not* reflected below:
>
> - **Motion is now opt-in.** This document was written when motion fusion ran by default and
>   `?motion=off` was the new escape hatch. That is now inverted: motion is **off unless** you
>   pass `?motion=on` or `?motion=strict`. The risk described under *Phone motion matching* is
>   therefore dormant by default rather than live — which is the better answer to it than any
>   flag.
> - **Several costs below have been improved** on `detection-tuning` (colour features skipped
>   when re-identification covers the room, OSNet moved to a Web Worker, cadence raised). See
>   the newer pipeline overview for current state.
>
> Everything else here still holds, including both open findings at the bottom.

## How a shot decides who it hit

Four signals exist. They are **not a committee that votes** — they are a fallback chain. The
strongest signal the phone can actually run wins outright; the others stay in reserve for a
device or a scan that cannot support the one above it.

| | Signal | Decides when |
| --- | --- | --- |
| **1** | **Person re-identification** (`reid.js`) — OSNet x0.25, trained specifically to tell people apart | Whenever present. Its score **is** the match score; nothing else is blended in, because blending measured *worse* than re-identification alone |
| **2** | **Colour + MobileNet embedding** (`identify.js`) — a generic image embedding blended with the colour signature | Re-id didn't load, but the embedder did |
| **3** | **Colour signature alone** (`identify.js`) — upper/lower-body hue histograms plus a coarse colour/shape grid. Canvas pixels only, no model | Neither model loaded. The baseline every device can run |

**Signal 4 — phone motion** (`motion/matching.js` + `motion/sensor.js`) sits outside this ranking
entirely. It is not a classifier and contributes no score of its own; it *confirms or vetoes*
whichever of 1–3 already named a track, by correlating that track's on-screen movement against
each phone's accelerometer. It enters through one seam, the identity provider's `resolve()` in
`motion-identity.js`, which `identity.js` installs only under `?motion=on`/`?motion=strict`.

## Every feature, individually

### Object detector — `detector.js`, EfficientDet-Lite0

Finds every person box in the frame, on a copy downscaled to ≤512 px wide. Three entry points
tuned for different jobs: the widest net during enrolment, a cheap pass most frames during play,
and a thorough pass (adding the pose fallback) every few hundred milliseconds.

| | |
| --- | --- |
| Cadence, acquiring | every 120 ms |
| Cadence, all identified | every 180 ms |
| One logged example | GPU · 8 fps · 23 ms |
| Delegate | GPU, falls back to CPU |

**Caveat:** that 23 ms / 8 fps figure is a single example reading quoted in the debug-mode docs
with all four optional models loaded — not a benchmark across devices. There is **no recorded
inference-time data for the object detector in isolation on any specific phone.** Everything
here about raw cost is architectural (how often it is asked to run), not measured.

### Pose landmarker fallback — `detector.js`, Pose Landmarker Lite

The one thing the object detector gets wrong: two people standing close together becoming one
box, or a person it misses outright. The pose model recovers both cases, but it is explicitly
"slower", hence gated hard rather than run every frame.

| | |
| --- | --- |
| Cadence | every 520 ms, max |
| Gate | ≥2 scanned players only |
| Also fires on | every shot (forced refresh) |

The "≥2 scanned players" gate means a two-player game with only one person scanned never pays
this cost at all — reasonable, since there is nothing to confuse yet. No measured cost exists for
this model either; "slower" is qualitative, from the module's own comment.

### Colour / shape signature — `identify.js`

Pure canvas pixel maths: upper and lower-body hue histograms, a coarse colour/chroma grid, and a
box-proportion check. No model, no async cost, always available as the floor every phone can run.

| | |
| --- | --- |
| Cost | canvas reads only |
| Accept threshold | score ≥ 0.54, margin ≥ 0.06 |
| Per-part floors | upper 0.50 · lower 0.38 · grid 0.40 · shape 0.36 |

**Known defect, still open.** `shapeSignature()` stores its live value raw, but every gallery
entry passes through `averageSignatures()`, which L2-**normalises** everything it averages —
including `shape`. A live signature and its own gallery sample therefore end up on different
scales, and `shapeSimilarity()` compares them anyway. Measured example: the same person's live
reading `[2.25, 3.0]` against their own gallery entry `[0.6, 0.8]` scores **0** instead of
roughly 1.

Net effect: the `shape` gate silently fails whenever re-identification and the embedder are both
absent, so colour-only matching runs without one of its four intended guards and never
accumulates evidence through that path at all — it survives on the closed-set forced-accept and
initial-streak-lock paths instead.

Not fixed because correcting it changes real matching behaviour and needs `MIN_SHAPE_SCORE` /
`EVIDENCE_MIN_PART` retuned alongside — a product-quality tradeoff, not a mechanical fix.

### MobileNet embedding — `identify.js`

A generic image-embedding model, not trained for re-identification specifically. It beats raw
colour but is not trusted to decide alone, so it is blended into the colour score at a 30%
weight rather than replacing it.

| | |
| --- | --- |
| Cost | synchronous, inline per check |
| Blend weight | 30% of the combined score |
| Falls back when | no usable region, or load failed |

**No accuracy figures exist for this signal in isolation** anywhere in the codebase — only the
blended colour+MobileNet numbers quoted against OSNet below. Its marginal contribution over
colour alone has never been measured on its own.

### OSNet re-identification — `reid.js`

The strongest signal, and the only one trained specifically to tell people apart across angles
and lighting. Runs asynchronously (request now, collect later) so it never blocks a frame; the
tracker simply waits for a track's first embedding before naming it from anything.

| | |
| --- | --- |
| Accept threshold | cosine ≥ 0.72 |
| Margin over runner-up | ≥ 0.03 |
| Latency model | async, one in flight per track |

Per single check, in the game's closed-set mode:

| Threshold | Players recognised | Bystanders accepted | Wrong player |
| --- | --- | --- | --- |
| 0.70 | 87% | 10.8% | 0.3–0.5% |
| **0.72 ← used** | **83%** | **7.6%** | 0.3–0.5% |
| 0.74 | 77% | 4.9% | 0.3–0.5% |
| 0.76 | 71% | 3.1% | 0.3–0.5% |

Measured on Market-1501 (people the model never saw). The *game-level* number quoted in
`reid.js`'s own header — 77% recognised at 5% bystander acceptance, across 2–4 enrolled players
with 20 bystanders each, after the tracker's hysteresis — is a **different measurement** (several
checks compounded, not one), which is why the two figures differ. Colour + MobileNet alone, same
simulation: 34%.

**None of this has been run against a real phone camera.** It is a fixed research dataset, not
footage from an actual match — real lighting, real motion blur and real lens characteristics are
all untested.

### Tracker — association, evidence, hysteresis — `identify.js`

Does not identify anyone itself. It is what keeps whatever the signals above decide from
flickering: threads boxes into persistent tracks frame to frame (IOU + velocity prediction),
re-checks identity on a schedule rather than every frame, accumulates a leaky-bucket "evidence"
score per candidate, and requires a challenger to win several consecutive checks before an
established name can change.

| | |
| --- | --- |
| Settle window | 6 checks, every frame, on a new track |
| Recheck interval | every 250 ms once named |
| Switch hysteresis | 4 consecutive agreeing checks |
| Evidence decay | ×0.82 per check |

This is the piece with the most tunable constants (14, grouped under "tuning constants" at the
top of `identify.js`) and the least direct test coverage of its own: `identify.test.js` covers
exactly one scenario — two tracks claiming the same player, the higher-scoring one keeps it. The
evidence/hysteresis interplay as a whole has never been measured, only reasoned about in
comments.

### Phone motion matching — `motion/matching.js` + `motion/sensor.js`

Not appearance at all. Correlates a tracked box's on-screen movement against each phone's own
accelerometer, 10 times a second, over a rolling 6-second window with up to ±400 ms of
clock-offset tolerance. Confirms a correct guess, vetoes a wrong one, or — rarely — redirects a
shot to a different candidate on correlation alone.

| | |
| --- | --- |
| Sample rate | 10 Hz, both sides |
| Correlation window | 6 s |
| Confirm / veto at | r ≥ 0.75 / r ≤ 0.30 |
| Recheck interval | every 300 ms |

| Simulated scenario | Result |
| --- | --- |
| Real player, 5 random seeds | matched every time |
| Bystander, 30 trials | ≤2 matched by coincidence, ≥12 clearly rejected |
| 6 s window vs. 4 s window | 4 s let 10–20% of bystanders through |

**The gap this audit exists partly to name:** every number above is a random-walk/stand-pattern
simulation with synthetic detector jitter — never a real accelerometer against a real camera.
Field conditions the simulation does not model at all: clock drift beyond the ±400 ms search
range, a phone in a pocket instead of held, a backgrounded tab throttling `devicemotion`. Any of
those can produce an "inconsistent" reading from noise alone, on a correct identification — at
which point this signal either silently drops the shot or redirects it.

*(Since written: motion is now off by default, so this is dormant unless explicitly enabled. See
the note at the top.)*

## Per-frame cost, consolidated

What actually runs, and how often, during normal play once at least one person is still being
identified.

| Stage | Interval | Trigger to run sooner |
| --- | --- | --- |
| Object detector | 120 ms (unidentified) / 180 ms (all named) | — |
| + Pose fallback | 520 ms, max | firing a shot (forced refresh) |
| Colour/embedding re-check | every frame × 6 (new track), then 250 ms | track loses its name |
| Re-identification embedding | async, request-and-collect, uncapped | — |
| Motion correlation re-check | 300 ms per track | — |
| Motion sample broadcast | 500 ms, this phone's own data | — |
| Shot freshness guard | forces a detection if the last is >90 ms old | pressing FIRE |

All figures are from source constants, cross-checked against the code that reads them. **No stage
here has a corresponding measured wall-clock cost on a real device** — the adaptive cadence
exists by design, calibrated by feel during development rather than against a profiling run.

## Findings

### Fixed when this audit ran

**Two different OSNet accuracy numbers, uncross-referenced.** `reid.js` and `identify.js` each
quoted a different "how good is OSNet" figure (77% vs. 83% recognised) because they measure
different things — game-level versus per-single-check — and neither said so. Both now point at
the other and name which measurement they are. No value or behaviour changed.

### Still open — needs a tuning decision

**The `shape` signature compares mismatched scales.** Detailed above. Silently neutralises one of
four guards in colour-only matching. Correcting the scale mismatch changes real accept/reject
behaviour and needs `MIN_SHAPE_SCORE` / `EVIDENCE_MIN_PART` retuned alongside it, which is a
product call this audit was not positioned to make unilaterally.

### Still open — needs real hardware

**Nothing past the colour signature has been measured on an actual phone.** OSNet's accuracy is a
fixed research dataset, not game footage. Motion matching's accuracy is a synthetic random-walk
simulation, not a real accelerometer. The frame-budget table above is architecture, not a
benchmark log. All three would benefit from the same thing: a short structured test on real
devices, starting with `?debug` for per-stage timings.

---

For the fuller backlog beyond this pipeline — the dual-backend history, the unreachable
`identify.js` edges, the dead protocol path — see [Streamlining](streamlining.md).
