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
| `?motion=off` | Clears `MOTION_ENABLED` (on by default): no motion-sensor prompt, no shared samples, and appearance alone decides who is shootable. See [Identification → Fusing it with the classifier](../client/identification.md#fusing-it-with-the-classifier-fusemotion). |
| `?motion=strict` | Sets `MOTION_ENABLED` and `REQUIRE_MOTION`: a shot only counts when the target's phone motion confirms who they are, never on the classifier alone. |
| `?motion=off` or no motion parameter | Sets `MOTION_OFF`: skips motion permission, sample sharing and motion fusion, so targeting uses appearance identity + `isStableTarget()` only. This is the default. |

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

Model options that aren't separate constants but are worth knowing about, inside `createDetector()`: the object detector takes `maxResults: 8` and the `person` category only; the pose landmarker takes `numPoses: 8` and detection/presence/tracking confidence `0.18`; the embedder is created with `l2Normalize: true, quantize: false`.

`frontend/public/screens/game.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `GAME_DETECT_MAX_WIDTH` | 512 | Frame width for in-game inference. Higher is more accurate at range, but slower. |
| `GAME_ACQUIRE_DETECT_INTERVAL_MS` | 120 | Detection interval while someone is unidentified |
| `GAME_TRACK_DETECT_INTERVAL_MS` | 180 | Detection interval once everyone visible is identified |
| `GAME_POSE_DETECT_INTERVAL_MS` | 520 | Minimum interval for the slower pose model |
| `SHOT_REFRESH_MAX_AGE_MS` | 90 | A shot triggers a fresh detection if the last one is older than this |

## Targeting

`frontend/public/motion-identity.js` (`LIVE_TRACK_MS` is the exception - it stays in `frontend/public/screens/game.js`, since only the game loop's own liveness check needs it). These decide when an identified person may be shot without motion confirmation, and are the main guard against crediting the wrong player.

| Constant | Default | Effect |
| --- | --- | --- |
| `LIVE_TRACK_MS` | 520 | A track counts as visible for this long after last being seen |
| `TARGET_LOCK_MS` | 350 | How long an identity must be held before it's targetable |
| `TARGET_MIN_SCORE` | 0.48 | Minimum overall match score (colour signature) |
| `TARGET_MIN_PART` | 0.22 | Minimum upper, lower and grid similarity (colour signature) |
| `reidTargetMinScore()` (identify.js) | threshold − 0.01 | Minimum score when the re-identification embedding decided. Tied to the threshold so raising it tightens shots too. |

All of these go into one flag, `isStableTarget()`, which is the classifier's "confident on its own". A track whose motion is confirmed by the target's own phone is targetable without it — only liveness (`LIVE_TRACK_MS`) still applies. See [Identification → Motion confirmation](../client/identification.md#motion-confirmation-motion).

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
| `SCAN_CACHE_VERSION` | 11 | Bump when the signature format changes (11 = samples carry a re-identification embedding) |

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
| `MIN_SHAPE_SCORE` | 0.36 |

**Acceptance, re-identification embedding.** These replace all of the above whenever both sides have a `reid` vector. The source comments record the measurement behind them:

| Constant | Default | Effect |
| --- | --- | --- |
| re-identification threshold (`REID_DEFAULT_THRESHOLD`, `?reid=`) | 0.70 | Cosine similarity needed to accept; override in the address, e.g. `?reid=0.68`, and read each person's best score off their box with `?debug`. On Market-1501, 0.70/0.72/0.74/0.76 recognised 87/83/77/71% of players and accepted 10.8/7.6/4.9/3.1% of bystanders per check. In real tests 0.80 recognised nobody (phones score lower than the benchmark); with the median below, players scored 0.70–0.80+ and non-players 0.60–0.65. |
| `REID_HISTORY_MS` (identify.js) | 3000 | Decisions use the median of a track's re-identification scores for each player over this window, not the latest check: a brief spike doesn't name a bystander and a single dip doesn't cost a player their name. Revoking a name (`REID_REVOKE_*`) still uses the latest checks. |
| `MOTION_SCORE_BONUS` / `MOTION_SCORE_PENALTY` (motion-identity.js) | +0.06 / −0.08 | Added to a track's typical score for a player when that player's phone motion is consistent / inconsistent with the person on screen. 0 with `?motion=off` or while nobody moves. |
| `REID_MATCH_MARGIN` | 0.03 | Lead over the runner-up. Halves wrong-player assignments. |
| `REID_EVIDENCE_MIN_SCORE` | threshold − 0.03 | Below this a rejected match contributes no evidence. Fixed at 0.62 before, which let evidence name anyone above it regardless of the threshold. |
| `REID_SOFT_LABEL_SCORE` | threshold − 0.015 | A rejected match this good can still be the track's candidate |
| `REID_REVOKE_SCORE`, `REID_REVOKE_CHECKS` | 0.6, 3 | A named track whose score for its own player stays below 0.6 for 3 checks in a row loses the name (someone else stepped into its box) |
| `reidInitialLock()` | threshold + 0.08, at least 0.80 | Score that names a brand-new track in one check |

**Tracker:**

| Constant | Default | Effect |
| --- | --- | --- |
| `ASSOCIATION_MATCH` | 0.3 | Minimum score to link a box to an existing track |
| `TRACK_TIMEOUT_MS` | 900 | Unseen tracks are dropped after this |
| `RECHECK_MS` | 250 | Re-identification interval for established tracks |
| `SETTLE_CHECKS` | 6 | New tracks are checked every detection for this many checks |
| `INITIAL_STREAK` | 2 | Agreeing checks to name a new track |
| `SWITCH_STREAK` | 4 | Agreeing checks to switch an existing identity |
| `HIGH_CONFIDENCE_INITIAL_LOCK` | 0.66 | Colour score that names a new track immediately |
| `EVIDENCE_DECAY` | 0.82 | Evidence kept per check |
| `EVIDENCE_ACCEPT` / `EVIDENCE_MARGIN` | 0.58 / 0.12 | Evidence needed to win, and lead needed over the next player |
| `EVIDENCE_MIN_SCORE` | 0.42 | Colour score below which a match contributes no evidence |
| `EVIDENCE_MIN_PART` | 0.24 | Minimum per-part similarity for evidence or a soft label |
| `SOFT_LABEL_SCORE` | 0.48 | Colour score at which a rejected match can still be the track's candidate |

**Box quality gates** (what counts as a person worth matching at all):

| Constant | Default | Effect |
| --- | --- | --- |
| `MIN_MATCH_HEIGHT_RATIO` | 0.18 | Box height as a fraction of the frame, in game |
| `MIN_BOX_WIDTH_RATIO` | 0.035 | Box width as a fraction of the frame, in game (scans use 0.025) |
| `MIN_ASPECT` / `MAX_ASPECT` | 0.58 / 6.5 | Accepted height/width ratio in game |
| `MIN_SCAN_ASPECT` / `MAX_SCAN_ASPECT` | 0.65 / 7.0 | Accepted height/width ratio while scanning |
| `MIN_SCAN_HEIGHT_RATIO` | 0.18 | Box height as a fraction of the frame, while scanning |

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

## Motion

`frontend/public/motion/sensor.js` (what this phone shares):

| Constant | Default | Effect |
| --- | --- | --- |
| `PANNING_DEG_PER_S` | 10 | Own rotation rate above which camera-image motion isn't trusted for that 100 ms bin |
| `HISTORY_MS` | 12 000 | How much of this phone's own history is kept |

`frontend/public/motion/matching.js` (the comparison). `SAMPLE_MS` is exported; the rest are the `DEFAULTS` object, overridable per call:

| Constant | Default | Effect |
| --- | --- | --- |
| `SAMPLE_MS` | 100 | Grid both series are resampled onto (10 Hz). Also the sensor's bin size. |
| `windowMs` | 6000 | How much history is correlated. 4 s windows let 10–20% of bystanders match by coincidence. |
| `maxLagMs` | 400 | Clock offset between phones that the search tolerates |
| `minValidFraction` | 0.6 | Share of the window that must be usable (data present, shooter not panning) |
| `minVisualSpread` | 0.08 | Box heights/s the person must actually vary by, or the answer is `unknown` |
| `minRemoteSpread` | 0.25 | m/s² the player's phone must actually vary by, or the answer is `unknown` |
| `consistentAt` | 0.75 | Correlation from which motion confirms the identity |
| `inconsistentAt` | 0.30 | Correlation at or below which an active pair contradicts it |
| `gapMs` (in `resample`) | 350 | How far a sample may be from a grid point and still be interpolated |

`frontend/public/motion-identity.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `MOTION_SEND_INTERVAL_MS` | 500 | How often this phone's new samples are sent to the room |
| `MOTION_CHECK_MS` | 300 | How often a track's motion checks are recomputed |
| `MOTION_HISTORY_MS` | 12 000 | History kept per remote player and per track |

## Tuning tips

- **Too many wrong-player hits:** raise `TARGET_MIN_SCORE` or the re-identification threshold (`?reid=`), `TARGET_MIN_PART` or `TARGET_LOCK_MS`, or require motion confirmation with `?motion=strict`.
- **Players stay "Person" too often:** check the [debug overlay](debug-mode.md) for the rejection reason before lowering the matching thresholds. If the overlay's delegate line has no `+ReID`, the re-identification model didn't load and matching is on the much weaker colour signature. A rescan in the playing area often fixes it without code changes.
- **Identity flickers between two players:** raise `SWITCH_STREAK`.
- **Motion never confirms anyone:** first make sure the URL doesn't have `?motion=off`. In debug mode, `motion off` means tracking is disabled, `no data` means no `devicemotion` events are arriving after permission, and `from nobody` means no other phone is sending samples.
- **Suspect motion fusion itself is causing bad shots (vetoed or retargeted hits):** use `?motion=off`, which bypasses `fuseMotion()` entirely and restores the appearance-only targeting gate (`isStableTarget()` only, no motion veto/correction).
- **Slow phones:** lower `GAME_DETECT_MAX_WIDTH` or raise the detection intervals. The re-identification model runs asynchronously, so it costs latency to the first identification rather than frame rate.
