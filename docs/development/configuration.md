# Configuration and tuning

There are no config files: behaviour is controlled by named constants at the top of each module. This page lists the ones worth changing, grouped by area.

## Environment variables

| Variable | Used by | Default |
| --- | --- | --- |
| `PORT` | Python backend | `4000` |

Published Docker ports (`8080`, `3443`) are set in `docker-compose.yml`.

## URL parameters

Read once at startup in `frontend/public/env.js`:

| Parameter | Effect |
| --- | --- |
| `?debug` | [Debug mode](debug-mode.md): debug clone, stats overlay, extra drawing and logging |
| `?room=<code>` | Pre-fills the room code on the join screen |
| `?reid=<0-1>` | Overrides the re-identification accept threshold for this device (`REID_THRESHOLD` in `env.js`, applied by `setReidThreshold()` in `identify.js`). Defaults to `REID_DEFAULT_THRESHOLD` (0.65). See the re-identification table below. |

## Game rules

Defined in `backend/models.py`.

| Constant | Default | Effect |
| --- | --- | --- |
| `MIN_PLAYERS` | 2 | Players needed to start |
| `MAX_PLAYERS` | 8 | Room capacity |
| `MAX_HP` | 100 | Starting HP |
| `DAMAGE` | body 20, head 50 | Damage per hit zone |
| `SHOT_COOLDOWN_MS` | 350 | Server-side minimum time between shots |
| `COUNTDOWN_MS` | 3000 | Countdown before a round |

The client has its own copies of two of these, used for display and local rate limiting: `FIRE_COOLDOWN_MS` (350, `frontend/public/screens/game.js`) and `GAME_LAUNCH_COUNTDOWN_MS` (3000, `frontend/public/screens/lobby.js`). Keep them equal to the server values.

## Networking

In `backend/transport.py`:

| Constant | Default | Effect |
| --- | --- | --- |
| `POLL_WAIT_MS` | 20 000 | How long a poll is held open. Keep it below your proxy's timeout. |
| `POLL_EXPIRY_MS` | 30 000 | A session with no activity for this long is dropped and its player leaves |
| `MAX_BODY_BYTES` | 1 MB (`1024 * 1024`) | Request body limit. A 24-sample gallery with re-identification embeddings is ~210 KB; see [gallery size](../server/protocol.md#gallery-format). |
| `MAX_MOTION_SAMPLES` | 32 | Motion samples accepted per relayed `motion` message (~3 s at 10 Hz) |
| `GALLERY_FIELDS` | | Accepted signature fields and their maximum lengths |

nginx has its own limit in `frontend/common-locations.conf`: `client_max_body_size 2m` on `/api/`. Raising `MAX_BODY_BYTES` above 2 MB means raising that too.

## Hitboxes

`frontend/public/detector.js`, as fractions of the person box:

| Constant | Default | |
| --- | --- | --- |
| `HEAD_TOP` | 0.02 | Head box top |
| `HEAD_HEIGHT` | 0.18 | Head box height |
| `HEAD_WIDTH` | 0.34 | Head box width (centred) |
| `BODY_TOP` | 0.22 | Body box top |
| `BODY_HEIGHT` | 0.72 | Body box height |
| `BODY_WIDTH` | 0.56 | Body box width (centred) |

Wider boxes are more forgiving but count more near-misses as hits.

## Detection

`frontend/public/detector.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `MIN_SCORE` | 0.35 | Object detector confidence threshold. Lower finds more people and more false positives. |
| `POSE_MIN_LANDMARKS` | 6 | Visible landmarks needed for a pose box |
| `TRACKED_POSE_MIN_SCORE` | 0.55 | Minimum pose box score to split or add boxes in the game |
| `OBJECT_MODEL_URL`, `POSE_MODEL_URL`, `EMBEDDER_MODEL_URL` | `/models/…` | Which model files to load |

Model options that aren't separate constants but are worth knowing about, in `detector.js`'s per-model factories: the object detector takes `maxResults: 8` and the `person` category only; the pose landmarker takes `numPoses: 8` and detection/presence/tracking confidence `0.18`; the embedder is created with `l2Normalize: true, quantize: false`. All three share `WASM_PATH` (`/vendor/tasks-vision/wasm`).

`frontend/public/screens/game.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `GAME_DETECT_MAX_WIDTH` | 512 | Frame width for in-game inference. Higher is more accurate at range, but slower. |
| `DETECT_INTERVAL_SEARCHING_MS` | 50 | Detection interval (20 fps) while anyone on screen is still being looked for — a track the detector just lost, or one with no identity yet. A target, not a promise: the duty cap and the camera's own frame rate both override it |
| `DETECT_INTERVAL_SETTLED_MS` | 100 | Detection interval (10 fps) once every live track is identified and none is coasting. Paying this is what buys the searching tier its headroom; the boxes stay smooth because they are drawn from `liveBox()` every animation frame, not from the last detection |
| `GAME_POSE_DETECT_INTERVAL_MS` | 520 | Minimum interval for the slower pose model |
| `GAME_POSE_SEARCH_INTERVAL_MS` | 200 | Pose interval while a track is coasting (`detectTier()` returns `lost`). Bounded by construction rather than by a timer: a track coasts for at most `TRACK_TIMEOUT_MS` before it is dropped |
| `SCAN_PREVIEW_DETECT_INTERVAL_MS` | 150 | Minimum interval for the scan screen's green highlight box — object detector only, on the `GAME_DETECT_MAX_WIDTH` copy, and skipped entirely while the rotation is recording. Purely cosmetic: nothing but `drawScan` reads it, so it cannot affect a gallery. Lower is a smoother-looking box and a hotter phone. |

`frontend/public/camera.js` — the first-inference warm-up (see [App flow → Join](../client/app-flow.md#join-join-screen)):

| Constant | Default | Effect |
| --- | --- | --- |
| `WARMUP_MAX_WIDTH` | 512 | Width of the warm-up frame. **Keep equal to `GAME_DETECT_MAX_WIDTH`** above, or the warm-up compiles shaders for a size the round won't use. Duplicated by value rather than imported, because `camera.js` importing from `screens/game.js` would close a cycle (`game.js` → `scan.js` → `camera.js`). |
| `WARMUP_FALLBACK_HEIGHT` | 288 | Height of the blank frame used when the camera hasn't produced one yet (16:9 at the width above) |
| `WARMUP_TIMESTAMP_MS` | 1 | Timestamp handed to the MediaPipe tasks. Must stay **below** every timestamp the game can pass, since VIDEO mode requires strictly increasing values per task; every real call derives one from `performance.now()`, already in the thousands by the time a model loads. Raising this is how you'd silently break detection later. |
| `WARMUP_REGION` | 0.3–0.7 × 0.08–0.95 | Where a person roughly stands in frame, so the embedder and re-identification warm their crop paths instead of being handed the whole frame |

## Targeting

`frontend/public/appearance-identity.js` (`LIVE_TRACK_MS` is the exception - it stays in `frontend/public/screens/game.js`, since only the game loop's own liveness check needs it). These decide when an identified person may be shot, and are the main guard against crediting the wrong player.

| Constant | Default | Effect |
| --- | --- | --- |
| `LIVE_TRACK_MS` | 520 | A track counts as visible for this long after last being seen |
| `TARGET_LOCK_MS` / `TARGET_LOCK_REID_MS` | 350 / 150 | How long an identity must be held before it's targetable (colour signature / re-identification) |
| `TARGET_MIN_SCORE` | 0.48 | Minimum overall match score (colour signature) |
| `TARGET_MIN_PART` | 0.22 | Minimum upper, lower and grid similarity (colour signature) |
| `reidTargetMinScore()` (identify.js) | threshold | Minimum score when the re-identification embedding decided. Tied to the threshold so raising it tightens shots too. |

All of these go into one flag, `isStableTarget()`, which is the classifier's "confident on its own".

## Scanning

`frontend/public/screens/scan.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `ROTATION_SCAN_COUNTDOWN_MS` | 3000 | Countdown before recording |
| `ROTATION_SCAN_DURATION_MS` | 12 000 | Recording length |
| `ROTATION_RECORD_FRAME_MS` | 180 | Delay between recorded frames |
| `ROTATION_FRAME_MAX_WIDTH` | 1024 | Recorded frame width |
| `SCAN_MIN_SAMPLES` | 12 | Fewer usable samples than this fails the scan |
| `SCAN_TARGET_SAMPLES` | 24 | Maximum gallery size (the server also caps at 24) |
| `SCAN_MIN_DETECTION_SCORE` | 0.16 | Minimum detector score for a usable frame |
| `SCAN_MIN_BRIGHTNESS` / `SCAN_MAX_BRIGHTNESS` | 0.08 / 0.94 | Brightness window |
| `SCAN_MIN_CONTRAST` | 0.025 | Minimum contrast |
| `SCAN_MIN_SHARPNESS` | 0.0035 | Minimum sharpness (motion-blur guard) |
| `SCAN_OUTLIER_SIMILARITY` | 0.36 | Outlier cut-off |
| `SCAN_DUPLICATE_SIMILARITY` | 0.992 | Near-duplicate cut-off |
| `SCAN_VIEW_AVERAGE_SIMILARITY` | 0.74 | Similarity needed to be averaged into a sample |
| `SCAN_DIVERSITY_WEIGHT` | 0.42 | How strongly sample selection prefers varied views |
| `ROTATION_SAMPLE_AVERAGE_COUNT` | 4 | Frames averaged per sample |
| `SCAN_DETECT_MAX_WIDTH` | 512 | Width detection runs at while processing a recording. Signatures still read the full-resolution frame. Mirrors `GAME_DETECT_MAX_WIDTH`. |
| `ROTATION_PROCESS_BATCH` | 3 | Recorded frames handled between renderer yields. Lower keeps the progress counter and ✕ snappier; higher spends less time waiting on frames. |
| `SCAN_CACHE_VERSION` (`scan-cache.js`) | see source | Bump when the signature format or the cache key changes, so phones discard caches that would be silently wrong rather than merely stale. [Why the version exists](../client/scanning.md#why-the-version-exists) |

`frontend/public/scan-reid.js` — the deferred OSNet pass:

| Constant | Default | Effect |
| --- | --- | --- |
| `REID_DISPATCH_BATCH` | 4 | Embeddings dispatched before yielding to the renderer. Each `embed()` snapshots its crop synchronously on the main thread and then runs the network in `reid.js`'s worker, so this is how long an uninterrupted run of snapshots may be. 1 is the old serial behaviour and leaves the worker idle between frames; much higher blocks the progress counter and the ✕ for a visible moment. |

`frontend/public/camera.js` — what enrolment waits for:

| Constant | Default | Effect |
| --- | --- | --- |
| `SCAN_MODEL_WAIT_MS` | 20 000 | How long a scan waits for the embedder and the recogniser before going ahead without them. Only a hung download can reach it — a model that *failed* resolves to `null` immediately. Lower risks enrolling a weaker gallery on a slow connection; higher risks a scan screen the player can only leave with the ✕. See [Scanning → Waiting for the models](../client/scanning.md#0-waiting-for-the-models-if-it-comes-to-that). |

`SCAN_SAMPLE_COUNT` (6) and `SCAN_SAMPLE_INTERVAL_MS` (70) belong to an older capture path (`captureScanSignature`) that the current rotation scan doesn't use.

Box-shape rules for scans (`MIN_SCAN_HEIGHT_RATIO` 0.18, `MIN_SCAN_ASPECT` 0.65, `MAX_SCAN_ASPECT` 7.0) are in `frontend/public/identify.js`.

## Identification

`frontend/public/identify.js`. The pipeline is explained in [Player identification](../client/identification.md).

**Feature weights** (each set sums to 1; keep it that way so the thresholds below keep their meaning). They apply only when no re-identification embedding is available — with one, it is the score on its own:

| Constants | Defaults |
| --- | --- |
| `HIST_WEIGHT`, `LOWER_WEIGHT`, `GRID_WEIGHT`, `SHAPE_WEIGHT` | 0.42, 0.24, 0.24, 0.10 |
| `EMBED_HIST_WEIGHT`, `EMBED_LOWER_WEIGHT`, `EMBED_GRID_WEIGHT`, `EMBED_SHAPE_WEIGHT`, `EMBED_WEIGHT` | 0.30, 0.18, 0.16, 0.06, 0.30 |

**Gallery blending** (how the best-matching angle is combined with the other angles that nearly agree):

| Constant | Default | Effect |
| --- | --- | --- |
| `GALLERY_TOP_MATCH_COUNT` | 3 | How many agreeing angles can support the best one |
| `GALLERY_AGREEMENT_WINDOW` | 0.1 | How far below the best an angle may score and still count as agreeing |
| `GALLERY_AGREEMENT_WEIGHT` | 0.25 | Share of the final score taken from the agreeing angles' average |
| `GALLERY_SUPPORT_BONUS` | 0.012 | Added per supporting angle |

**Acceptance, colour signature (open-set):**

| Constant | Default |
| --- | --- |
| `MATCH_THRESHOLD` | 0.54 |
| `MATCH_MARGIN` | 0.06 |
| `MIN_UPPER_SCORE` | 0.50 |
| `MIN_LOWER_SCORE` | 0.38 |
| `MIN_GRID_SCORE` | 0.40 |
| `MIN_SHAPE_SCORE` | 0.36 — **deliberately unchanged**, see below |

`MIN_SHAPE_SCORE` is worth a paragraph, because its value does not mean what the others' do. Until
the normalisation fix, `shape` returned 0 for everyone, so 0.36 had
never gated anything and was chosen against a dead feature. The fix made the gate *reachable*
without retuning it: that is the conservative state to leave it in, since lowering or raising it
both need a real distribution of colour-only `s` scores, and the only numbers that exist are
synthetic. Collect real values with `?debug` on a device where OSNet does not load before moving
it. The same applies to `EVIDENCE_MIN_PART` below. See [Open items](../open-items.md).

`MIN_SHAPE_SCORE`, `EVIDENCE_MIN_PART` and `EVIDENCE_MIN_SCORE` are **exported** from
`identify.js`, so anything measuring against them reads the live value rather than a copy.

**Acceptance, re-identification embedding.** These replace all of the above whenever both sides have a `reid` vector. The source comments record the measurement behind them:

| Constant | Default | Effect |
| --- | --- | --- |
| re-identification threshold (`REID_DEFAULT_THRESHOLD`, `?reid=`) | 0.65 | Cosine similarity needed to accept; override in the address, e.g. `?reid=0.68`, and read each person's best score off their box with `?debug`. On Market-1501, 0.70/0.72/0.74/0.76 recognised 87/83/77/71% of players and accepted 10.8/7.6/4.9/3.1% of bystanders per check. In real tests 0.80 recognised nobody (phones score lower than the benchmark); with the median below, players scored 0.70–0.80+ and non-players 0.60–0.65, and 0.70 and 0.68 had no false positives. Go back to `?reid=0.68` if bystanders get named. |
| `REID_HISTORY_MS` (identify.js) | 3000 | Decisions use the median of a track's re-identification scores for each player over this window, not the latest check: a brief spike doesn't name a bystander and a single dip doesn't cost a player their name. Revoking a name (`REID_REVOKE_*`) still uses the latest checks. |
| `REID_MATCH_MARGIN` | 0.03 | Lead over the runner-up. Halves wrong-player assignments. |
| `reidEvidenceMinScore()` | threshold | Below this a check contributes no evidence. Was fixed at 0.62, then threshold − 0.03, which at 0.65 let people who usually score 0.62–0.64 build up evidence and get named; the 3 s median bridges bad checks instead. |
| `reidSoftLabelScore()` | threshold | A rejected match this good can still be the track's candidate |
| `REID_REVOKE_SCORE`, `REID_REVOKE_CHECKS` | 0.6, 3 | A named track whose score for its own player stays below 0.6 for 3 checks in a row loses the name (someone else stepped into its box) |
| `reidInitialLock()` | threshold + 0.08, at least 0.80 | Score that names a brand-new track in one check |

**Tracker:**

| Constant | Default | Effect |
| --- | --- | --- |
| `ASSOCIATION_MATCH` | 0.3 | Minimum score to link a box to an existing track |
| `TRACK_TIMEOUT_MS` | 900 | Unseen tracks are dropped after this |
| `RECHECK_MS` | 100 | Identity recheck interval for established tracks (10 Hz). Four check *counts* are calibrated against it — `REID_REVOKE_CHECKS`, `SWITCH_STREAK`, `INITIAL_STREAK` — so moving it means moving those to keep the durations they stand for |
| `REID_REQUEST_MS` | 220 | How often a track may ask `reid.js` for a fresh embedding (~4.5 Hz). Separate from `RECHECK_MS` because `reid.request()` does a 128 × 256 `getImageData` readback on the main thread |
| `INITIAL_STREAK` | 2 | Agreeing checks to name a new track |
| `SWITCH_STREAK` | 4 | Agreeing checks to switch an existing identity |
| `HIGH_CONFIDENCE_INITIAL_LOCK` | 0.66 | Colour score that names a new track immediately |
| `EVIDENCE_DECAY` | 0.82 | Evidence kept per check |
| `EVIDENCE_ACCEPT` / `EVIDENCE_MARGIN` | 0.58 / 0.12 | Evidence needed to win, and lead needed over the next player |
| `EVIDENCE_MIN_SCORE` | 0.42 | Colour score below which a match contributes no evidence |
| `EVIDENCE_MIN_PART` | 0.24 | Minimum per-part similarity for evidence or a soft label. **Deliberately unchanged** alongside `MIN_SHAPE_SCORE`: it applies to all four colour parts, so while `shape` was stuck at 0 no colour-path check accumulated evidence at all. The fix restored that path rather than retuning its floor — a real game on a phone without OSNet is the check it wants, not more fixtures. |
| `SOFT_LABEL_SCORE` | 0.48 | Colour score at which a rejected match can still be the track's candidate |

**Box quality gates** (what counts as a person worth matching at all):

| Constant | Default | Effect |
| --- | --- | --- |
| `MIN_MATCH_HEIGHT_RATIO` | 0.18 | Box height as a fraction of the frame, in game. **Deliberately unchanged** — the far band below relaxes it for one signal instead of moving it |
| `MIN_BOX_WIDTH_RATIO` | 0.035 | Box width as a fraction of the frame, in game (scans use 0.025) |
| `MIN_ASPECT` / `MAX_ASPECT` | 0.58 / 6.5 | Accepted height/width ratio in game |
| `MIN_SCAN_ASPECT` / `MAX_SCAN_ASPECT` | 0.65 / 7.0 | Accepted height/width ratio while scanning |
| `MIN_SCAN_HEIGHT_RATIO` | 0.18 | Box height as a fraction of the frame, while scanning |

**The far re-identification band** (how far past `MIN_MATCH_HEIGHT_RATIO` signal 1 alone may still
try — see [Box range and the far band](../client/identification.md#box-range-and-the-far-band)):

| Constant | Default | Effect |
| --- | --- | --- |
| `FAR_REID_MIN_HEIGHT_RATIO` | 0.09 | Box height floor for the band. 256 px of OSNet input ÷ 4× upscale = 64 px, ÷ 720 |
| `FAR_REID_MIN_WIDTH_RATIO` | 0.025 | Box width floor for the band. 128 px ÷ 4× = 32 px, ÷ 1280 |
| `FAR_REID_MAX_PENALTY` | 0.11 | Added to the re-identification threshold at the floor, i.e. 0.76 there. Scales as the squared shortfall below 0.18, so it is ~0 just inside the band |

These are the only range numbers that are open to tuning. `MIN_MATCH_HEIGHT_RATIO` is not: the
whole point of the band is that at or above 0.18 nothing changed, and that property is what makes
it safe at the ranges that already worked (`test/range-reid-gate.test.js` asserts the match object
is identical to a pre-band one). Both floors are
derived from OSNet's 128 × 256 input rather than picked, so if you move them, move them by changing
the upscale factor you are willing to accept and say so — the arithmetic is in the comment beside
them in `identify.js`. Raising `FAR_REID_MAX_PENALTY` makes the band stricter; setting it to 0
removes the band's protection entirely and is how it would start naming bystanders.

**Signature resolution:** `HUE_BINS` (12), `SAT_BINS` (4), `LUMA_BINS` (8), `SAT_DETAIL_BINS` (8), `GRID_W` (6), `GRID_H` (8), `GRID_FEATURES` (4), `EMBED_DIMS` (256), `EMBED_PRECISION` (10 000, i.e. 4 decimals). Changing any of these changes vector lengths: bump `SCAN_CACHE_VERSION` and check `GALLERY_FIELDS` limits on both servers.

## Re-identification model

`frontend/public/reid.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `MODEL_URL` | `/models/osnet_x0_25_msmt17.onnx` | The OSNet model file (0.9 MB) |
| `WIDTH` / `HEIGHT` | 128 / 256 | Model input size; crops are resized to this |
| `MEAN` / `STD` | ImageNet values | Input normalisation. Must match how the model was trained. |
| `PRECISION` | 10 000 | Rounding of the output vector (4 decimals), to keep galleries small on the wire |
| `REID_DIMS` | 512 | Embedding length (exported; `GALLERY_FIELDS` must allow at least this) |

Two more behaviours are set inline rather than as named constants:

- `latest(key, maxAgeMs = 800)` — an embedding older than 800 ms is treated as missing, so the tracker waits for a fresh one instead of matching a stale crop.
- `ort.env.wasm.numThreads` — up to 4 threads when the page is cross-origin isolated, otherwise 1. The game isn't isolated, so in practice it's 1.

Changing `WIDTH`, `HEIGHT`, `MEAN` or `STD` without retraining will quietly degrade accuracy rather than fail.

## Tuning tips

- **Too many wrong-player hits:** raise `TARGET_MIN_SCORE` or the re-identification threshold (`?reid=`), `TARGET_MIN_PART` or `TARGET_LOCK_MS`.
- **Players stay "Person" too often:** check the [debug overlay](debug-mode.md) for the rejection reason before lowering the matching thresholds. If the overlay's delegate line has no `+ReID`, the re-identification model didn't load and matching is on the much weaker colour signature. A rescan in the playing area often fixes it without code changes.
- **Identity flickers between two players:** raise `SWITCH_STREAK`.
- **Slow phones:** lower `GAME_DETECT_MAX_WIDTH` or raise the detection intervals. The re-identification model runs asynchronously, so it costs latency to the first identification rather than frame rate.
