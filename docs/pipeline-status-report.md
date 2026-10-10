# Vision pipeline — status report

A report on one round of work across detection, identification, scanning and motion: what
changed, what was found, and the four decisions that need a human rather than another commit.

Test state at the time of writing: **19 JS + 32 backend tests passing.**

## What changed

| Change | Effect |
| --- | --- |
| **Position and velocity filtered apart** (`identify.js`) | Box trailing **22.6 px → 7.5 px** *and* velocity noise **18 → 12 px/s**. Both filters are now exponential time constants rather than one shared per-detection blend factor, so lag no longer scales with the detection interval — which matters because the interval isn't fixed (80–180 ms by schedule, longer under load). |
| **Motion sealed behind one provider** (`identity.js`) | `screens/game.js`, `net.js`, `state.js` and `app.js` now contain zero occurrences of the word "motion". The feature can be deleted or swapped at one seam. |
| **First-inference warm-up** (`camera.js`) | MediaPipe compiles shaders and ONNX builds kernels on a model's *first* inference, not at load. That cost used to land during the countdown for any phone that never scanned anybody. Now paid once on the join screen. |
| **Motion sample truncation fixed** (`backend/sanitize.py`) | `samples[:32]` kept the **oldest** 32, discarding exactly the recent samples the 6 s correlation window needs. Now `samples[-32:]`. |
| **Documentation** | [History and model inventory](vision-pipeline-history.md), [per-feature audit](detection-pipeline-audit.md), [motion-only experiment](motion-only-experiment.md), [motion capture harness](motion-capture.md). |

Scanning work was in progress when this was written — see [Scanning](client/scanning.md) for its
current state.

## Findings

### The pipeline's shape is explained by its history, not by design

Traced from git: the 42-hour demo shipped **one model and zero identification**. Each of the other
three arrived to fix a named failure. Two things follow, both recorded in
[the history doc](vision-pipeline-history.md):

- **Nothing was throttled for the first four PRs.** Detection ran on every new camera frame, at
  full 1280 px, through *both* the object detector and the pose landmarker. The 512 px downscale
  and the adaptive interval arrived together as one correction.
- **The arc after PR #4 was driven by false positives, not performance.** PR #7's branch is named
  `working-classifier-that-overclassifies`; OSNet's commit is "to stop over-classification". Every
  accuracy fix meant more inference, which is what forced the throttling. The performance work is
  *downstream* of an accuracy problem — which is why it reads as bolted on.

### MobileNet is wasted work, not just dead weight

On the current code, `extractSignature()` runs the MobileNet embedding **before** OSNet is
consulted:

```js
const signature = extractSignature(video, track.box, embedder, now);  // MobileNet runs
if (reid) {
  signature.reid = reid.latest(track);
  reid.request(track, video, track.box);
  if (!signature.reid) continue;                                       // ...discarded
}
```

So whenever OSNet has an embedding, the MobileNet result is computed and ignored (`score: hasReid
? reid : …`). And on a track still awaiting its first embedding, that `continue` throws away the
colour features *and* the embedding — the most expensive possible no-op. This is a real slice of
the 13–20 ms per detection.

`detection-tuning` fixes it with `reidDecides`, which correctly requires *every* player to have
re-id in their gallery before skipping — so one player on a pre-OSNet cached scan drops the whole
room back to the blended path rather than scoring people on different scales.

### Model payload is inversely correlated with contribution

| Model | Size | Contribution |
| --- | --- | --- |
| EfficientDet-Lite0 | 7.0 MB | Required — no boxes, no game |
| Pose Landmarker Lite | 5.6 MB | One narrow case: splitting a box that covers two people |
| MobileNetV3 embedder | 4.0 MB | Bypassed whenever re-identification works |
| OSNet x0.25 | **871 KB** | Does the actual identification (77% vs 34% without it) |

**871 KB does the work; 9.6 MB of the 18 MB payload is the two weakest contributors.**

### Motion can let a confidently-wrong identification through

Found by the capture/replay harness on its own fixture, and it is a property of the real fusion
table rather than a simulation artifact: a wrong-but-confident classifier identification is only
**vetoed** when the wrongly-named player's motion check is *decisively* inconsistent. Where it is
merely `unclear`, the wrong identification stands via `classifier-only`.

In the fixture that meant a shot landing on the wrong player **36 of 60 times**. Replaying with
`--requireMotion` turned all 36 into no-ops. This is exactly the tradeoff `?motion=strict`
exists for — now measurable rather than argued about. It only applies with `?motion=on`, since
motion is off by default.

## Four decisions that need a human

### 1. The `shape` feature is inert and needs a tuning call

Gallery entries are L2-normalised by `averageSignatures()`; live signatures are not.
`shapeSimilarity()` compares the two anyway, so the same person scores **0** instead of ~1. One
of four colour-path guards never fires, and the evidence accumulator never fills through that
path. Fixing the scale changes real accept/reject behaviour and needs `MIN_SHAPE_SCORE` /
`EVIDENCE_MIN_PART` retuned with it — which is why it is still open rather than quietly patched.

### 2. Whether MobileNet stays

Once `detection-tuning` lands, it is 4 MB that never executes in the normal case, kept so a phone
where OSNet fails to load still beats raw colour. Whether that is worth 22% of the payload depends
on one number nobody has: **how often does OSNet actually fail to load on real phones?** `?debug`
already shows it — a missing `+ReID` on the first overlay line — so a few phones' worth of field
testing settles it.

### 3. Nothing past the colour signature has been measured on a phone

OSNet's accuracy is a research dataset. Motion's is a simulation. The frame budget is
architecture, not a profile. The [capture harness](motion-capture.md) makes a real motion
measurement *possible* but does not constitute one — each open question (pocket vs. held, ±400 ms
on a real network, backgrounded-tab throttling) needs a session recorded under that condition.

### 4. CI still runs no tests before deploying

The workflow triggers on a closed pull request into `dev` and does one thing: SSH in, `git
checkout dev && git pull && docker compose up --build -d`. Neither test suite runs first, though
both are containerised and ready (`docker compose run --rm tests` and `backend-tests`). A broken
change reaches the live server with nothing catching it.

Note also that a **direct push to `dev` does not deploy** — but it does stage that code for
whenever the next PR into `dev` closes.

## Scanning is the largest untouched target

It is the heaviest path in the app and the one none of the above helps: 12 s of recording, then a
second full pass running detection *and* OSNet per frame. The colour-skip cannot help (no
galleries exist yet, mid-scan) and the warm-up cannot either (scanning uses full-resolution video
and 1024 px canvases, not the 512 px path that gets warmed). Its processing loop is serial and
awaits each embedding — which the Web Worker on `detection-tuning` makes parallelisable for the
first time.
