# How the on-device vision pipeline came to be

Four ML models run in the phone browser today, plus a tracker, an adaptive detection cadence, a
downscaled inference path and a non-visual confirmation signal. None of that was designed up
front. Every piece was added to fix a specific failure, and knowing which failure explains why
the pipeline has the shape it does.

For how it works *now*, see [Detection](client/detection.md) and
[Identification](client/identification.md). For what each stage costs and how accurate it is, see
the [detection pipeline audit](detection-pipeline-audit.md). This page is the history and the
model inventory.

## The arc

| Stage | Commit / PR | What arrived |
| --- | --- | --- |
| The 42-hour demo | `e99fae0` | **EfficientDet-Lite0 only.** No identification whatsoever — whoever the camera saw counted as the opponent, so the README told you to keep bystanders out of shot. Hitboxes were 0.2 × 0.5 of the person box. Detection ran on **every new camera frame**, full resolution, no throttle. |
| **PR #3** | `810075a` | `class Tracker`, the colour signature, galleries, the enrolment scan. The first time the game knew *who* it was looking at. |
| PR #3 | `5905a33` | `evidenceWinner` — the leaky-bucket evidence accumulator, so one good frame stops being decisive. |
| PR #3 | `8553509` | **Pose Landmarker** (2nd model), to split one box covering two people and to recover people the object detector missed. |
| **PR #4** | `4a72ea8` | **MobileNetV3 embedder** (3rd model), blended with the colour score. |
| PR #4 | `4928e80` | Scoring-threshold refinements. |
| **PR #7** | `0de34ed` | **`GAME_DETECT_MAX_WIDTH` (512 px) and `GAME_ACQUIRE_DETECT_INTERVAL_MS` (adaptive cadence)** — both in one commit. The first time detection was throttled at all. |
| PR #7 | `84e374c` | `closedSet` assignment, and `SHOT_REFRESH_MAX_AGE_MS` — a forced fresh detection when you fire. |
| improved-classifier | `f4dfa39` | **OSNet x0.25** (4th model), purpose-built person re-identification. |
| **PR #9** | `3a428dc` | **Phone motion matching** — the first signal that isn't vision at all. |
| unmerged (`detection-tuning`) | `05c78f0` … `3a9f783` | Colour features skipped when re-id covers the room; OSNet moved to a Web Worker; cadence 80/120 ms with a duty cap; velocity-projected boxes; every re-id gate tied to the accept threshold. |

## Two things the history makes obvious

**Nothing was throttled for the first four PRs.** Before `0de34ed`, `loop()` ran detection on
every new camera frame — roughly 30 times a second, at full 1280 px, through *both* the object
detector and the pose landmarker. The 512 px downscale and the 120/180 ms adaptive interval
arrived together, as one correction, once that had become untenable.

**The whole arc after PR #4 was driven by false positives, not by performance.** PR #7's branch
is named `working-classifier-that-overclassifies`; the OSNet commit is titled "to stop
over-classification". Bystanders were being labelled as players. Every fix for that meant *more*
inference — a second detector, a third model, a fourth — which is what forced the throttling,
the downscale, and eventually the Web Worker. The performance work is downstream of an accuracy
problem, which is why it looks bolted on: it is.

## The model inventory

| Model | File size | Job | Strictly required? |
| --- | --- | --- | --- |
| EfficientDet-Lite0 | **7.0 MB** | Person boxes | **Yes.** No boxes, no game. |
| Pose Landmarker Lite | **5.6 MB** | Split one box covering two people; recover a person the object detector missed | No |
| MobileNetV3 Small embedder | **4.0 MB** | Generic appearance embedding, blended at 30% weight | No |
| OSNet x0.25 (MSMT17) | **871 KB** | Purpose-built person re-identification | No, by code — but see below |

Total payload ≈ **18 MB**, committed to the repo so the game works offline.

### What each one actually earns

**Pose Landmarker** earns its keep in exactly one scenario: two players standing close enough
that the object detector draws a single box around both, which yields one identity and makes the
wrong player take the hit. It also widens the net during enrolment. It is gated hard —
only with ≥2 enrolled players, at most every 520 ms — precisely because it is expensive relative
to how narrow that job is.

**MobileNetV3 is the one worth questioning.** It was never trained to tell people apart; it is a
generic image embedding that merely beats raw colour. And on `detection-tuning` it is *actively
bypassed*: when every player's gallery carries OSNet embeddings, `extractSignature()` is called
with `embedder: null` and the colour features are skipped with it. In the configuration the
project is moving toward, 4 MB downloads, gets warmed up, and never runs. Its only remaining role
is as a fallback if OSNet fails to load.

**OSNet is effectively load-bearing despite being optional.** When present it *overrides* colour
and MobileNet entirely — blending them in measured worse than re-identification alone. And while
it is loaded but has not yet produced an embedding for a track, the tracker refuses to identify
that track from colour at all, because colour-only matching is exactly what caused the
over-classification it was brought in to fix. Remove it and identification quality falls from 77%
to 34% by the project's own evaluation.

### The size/value inversion

File size is roughly *inversely* correlated with contribution here:

- **871 KB** of OSNet does the actual identification.
- **9.6 MB** — more than half the payload — is the pose model (one narrow edge case) plus a
  MobileNet that is already switched off in the target configuration.

If first-load time on phones ever becomes a priority, that is where to look. Dropping MobileNet
alone would save 4 MB for a signal that is already bypassed whenever re-identification is
working — at the cost of graceful degradation on a phone where OSNet fails to load. That is a
real tradeoff, not a free win, which is why it is recorded here rather than acted on.

## Where to read next

- [Detection](client/detection.md) — the models, the three detection entry points, hitboxes
- [Identification](client/identification.md) — signatures, matching, the tracker, the signal order
- [Scanning](client/scanning.md) — enrolment, and the scan path's own model usage
- [Detection pipeline audit](detection-pipeline-audit.md) — per-stage cost and accuracy, and which
  of those numbers are measured versus simulated
- [Streamlining](streamlining.md) — the open backlog, including the inert `shape` feature
