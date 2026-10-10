# Configuration and tuning

There are no config files: behaviour is controlled by named constants at the top of each module. This page lists the ones worth changing, grouped by area.

## Environment variables

| Variable | Used by | Default |
| --- | --- | --- |
| `PORT` | Python backend | `4000` |
| `PORT` | Node dev server (HTTP) | `3000` |
| `HTTPS_PORT` | Node dev server (HTTPS) | `3443` |

Published Docker ports (`8080`, `3443`) are set in `docker-compose.yml`.

## Game rules

Defined in **both** `server/game.js` and `backend/app.py`. Change them together.

| Constant | Default | Effect |
| --- | --- | --- |
| `MIN_PLAYERS` | 2 | Players needed to start |
| `MAX_PLAYERS` | 8 | Room capacity |
| `MAX_HP` | 100 | Starting HP |
| `DAMAGE` | body 20, head 50 | Damage per hit zone |
| `SHOT_COOLDOWN_MS` | 350 | Server-side minimum time between shots |
| `COUNTDOWN_MS` | 5000 | Countdown before a round |

The client has its own copies of two of these, used for display and local rate limiting: `FIRE_COOLDOWN_MS` (350) and `GAME_LAUNCH_COUNTDOWN_MS` (5000) in `public/app.js`. Keep them equal to the server values.

## Networking

In both `server/realtime.js` and `backend/app.py`:

| Constant | Default | Effect |
| --- | --- | --- |
| `POLL_WAIT_MS` | 20 000 | How long a poll is held open. Keep it below your proxy's timeout. |
| `POLL_EXPIRY_MS` | 30 000 | A session with no activity for this long is dropped and its player leaves |
| `MAX_BODY_BYTES` | 256 KB | Request body limit. See the note on [gallery size](../server/protocol.md#gallery-format). |
| `GALLERY_FIELDS` | | Accepted signature fields and their maximum lengths |

## Hitboxes

`public/detector.js`, as fractions of the person box:

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

`public/detector.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `MIN_SCORE` | 0.35 | Object detector confidence threshold. Lower finds more people and more false positives. |
| `POSE_MIN_LANDMARKS` | 6 | Visible landmarks needed for a pose box |
| `TRACKED_POSE_MIN_SCORE` | 0.55 | Minimum pose box score to split or add boxes in the game |

`public/app.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `GAME_DETECT_MAX_WIDTH` | 512 | Frame width for in-game inference. Higher is more accurate at range, but slower. |
| `GAME_ACQUIRE_DETECT_INTERVAL_MS` | 120 | Detection interval while someone is unidentified |
| `GAME_TRACK_DETECT_INTERVAL_MS` | 180 | Detection interval once everyone visible is identified |
| `GAME_POSE_DETECT_INTERVAL_MS` | 520 | Minimum interval for the slower pose model |
| `SHOT_REFRESH_MAX_AGE_MS` | 90 | A shot triggers a fresh detection if the last one is older than this |

## Targeting

`public/app.js`. These decide when an identified person may be shot, and are the main guard against crediting the wrong player.

| Constant | Default | Effect |
| --- | --- | --- |
| `LIVE_TRACK_MS` | 520 | A track counts as visible for this long after last being seen |
| `TARGET_LOCK_MS` | 350 | How long an identity must be held before it's targetable |
| `TARGET_MIN_SCORE` | 0.48 | Minimum overall match score |
| `TARGET_MIN_PART` | 0.22 | Minimum upper, lower and grid similarity |

## Scanning

`public/app.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `ROTATION_SCAN_COUNTDOWN_MS` | 5000 | Countdown before recording |
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
| `SCAN_CACHE_VERSION` | 10 | Bump when the signature format changes |

`SCAN_SAMPLE_COUNT` and `SCAN_SAMPLE_INTERVAL_MS` belong to an older capture path (`captureScanSignature`) that the current rotation scan doesn't use.

Box-shape rules for scans (`MIN_SCAN_HEIGHT_RATIO`, `MIN_SCAN_ASPECT`, `MAX_SCAN_ASPECT`) are in `public/identify.js`.

## Identification

`public/identify.js`. The pipeline is explained in [Player identification](../client/identification.md).

**Feature weights** (each set sums to 1; keep it that way so the thresholds below keep their meaning):

| Constants | Defaults |
| --- | --- |
| `HIST_WEIGHT`, `LOWER_WEIGHT`, `GRID_WEIGHT`, `SHAPE_WEIGHT` | 0.42, 0.24, 0.24, 0.10 |
| `EMBED_HIST_WEIGHT`, `EMBED_LOWER_WEIGHT`, `EMBED_GRID_WEIGHT`, `EMBED_SHAPE_WEIGHT`, `EMBED_WEIGHT` | 0.30, 0.18, 0.16, 0.06, 0.30 |

**Acceptance (open-set):**

| Constant | Default |
| --- | --- |
| `MATCH_THRESHOLD` | 0.54 |
| `MATCH_MARGIN` | 0.06 |
| `MIN_UPPER_SCORE` | 0.50 |
| `MIN_LOWER_SCORE` | 0.38 |
| `MIN_GRID_SCORE` | 0.40 |
| `MIN_SHAPE_SCORE` | 0.36 |

**Tracker:**

| Constant | Default | Effect |
| --- | --- | --- |
| `ASSOCIATION_MATCH` | 0.3 | Minimum score to link a box to an existing track |
| `TRACK_TIMEOUT_MS` | 900 | Unseen tracks are dropped after this |
| `RECHECK_MS` | 250 | Re-identification interval for established tracks |
| `SETTLE_CHECKS` | 6 | New tracks are checked every detection for this many checks |
| `INITIAL_STREAK` | 2 | Agreeing checks to name a new track |
| `SWITCH_STREAK` | 4 | Agreeing checks to switch an existing identity |
| `HIGH_CONFIDENCE_INITIAL_LOCK` | 0.66 | Score that names a new track immediately |
| `EVIDENCE_DECAY` | 0.82 | Evidence kept per check |
| `EVIDENCE_ACCEPT` / `EVIDENCE_MARGIN` | 0.58 / 0.12 | Evidence needed to win, and lead needed over the next player |

**Signature resolution:** `HUE_BINS`, `SAT_BINS`, `LUMA_BINS`, `SAT_DETAIL_BINS`, `GRID_W`, `GRID_H`, `EMBED_DIMS`. Changing any of these changes vector lengths: bump `SCAN_CACHE_VERSION` and check `GALLERY_FIELDS` limits on both servers.

## Tuning tips

- **Too many wrong-player hits:** raise `TARGET_MIN_SCORE`, `TARGET_MIN_PART` or `TARGET_LOCK_MS`.
- **Players stay "Person" too often:** check the [debug overlay](debug-mode.md) for the rejection reason before lowering the matching thresholds. A rescan in the playing area often fixes it without code changes.
- **Identity flickers between two players:** raise `SWITCH_STREAK`.
- **Slow phones:** lower `GAME_DETECT_MAX_WIDTH` or raise the detection intervals.
