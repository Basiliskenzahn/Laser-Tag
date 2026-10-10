# Scanning (enrolment)

Before a round, every player is scanned so the other phones can recognise them. A scan produces a **gallery**: 12 to 24 appearance [signatures](identification.md#signatures), each from a different viewing angle, each carrying the colour features and — when the model loaded — a [re-identification embedding](identification.md#the-re-identification-embedding-reidjs). The gallery is uploaded to the server and shared with every phone in the room.

The code lives in `frontend/public/screens/scan.js`. Signature extraction itself is in [`identify.js`](identification.md).

## Who scans whom

Any phone can scan any player: each lobby row has a **Scan** button, and the gallery is saved under that player's id (`{type: 'scan', targetId, gallery}`). Usually players pair up and scan each other. The server refuses scans while a round is in countdown or playing.

`beginPlayerScan(player)` sets `state.scanTargetId`/`scanTargetName`, swaps to the scan screen, keeps the screen awake, and then — after one paint, so the screen is actually visible first — starts `runAutoScan()`.

## Pipeline

```mermaid
flowchart TD
  A[Tap Scan] --> A2[Wait for the embedder and<br/>the recogniser, if still loading]
  A2 --> B[3 s countdown<br/>player faces camera<br/>object-only preview, 150 ms]
  B --> C[Record 12 s<br/>~60 frames, max 1024 px wide<br/>no analysis at all]
  C --> D[Per frame: object detector<br/>on a 512-wide copy]
  D --> E[Quality gates:<br/>framing, confidence, light,<br/>contrast, sharpness]
  E --> F[Colour signature +<br/>MobileNet embedding<br/>at full resolution]
  F --> G[Remove outliers<br/>and near-duplicates]
  G --> H{More than 24?}
  H -- yes --> I[Pick 24 diverse seeds,<br/>average each with similar neighbours]
  H -- no --> J
  I --> J[Order samples by view]
  J --> K{At least 12?}
  K -- no --> L[Back to lobby with<br/>the most common problem]
  K -- yes --> M[Thumbnails + OSNet embedding<br/>for the chosen samples only]
  M --> N[Cache locally, send scan<br/>to server, back to lobby]
```

The phases and roughly what each costs:

| Phase | Duration | Work |
| --- | --- | --- |
| Model wait | Usually none | Only if the embedder or the recogniser is still loading; see below. |
| Countdown | 3 s (`ROTATION_SCAN_COUNTDOWN_MS`) | The preview detection: the object detector alone, on a 512-wide copy, at most every 150 ms. ~20 inferences. |
| Recording | 12 s (`ROTATION_SCAN_DURATION_MS`) | One `drawImage` per frame. No inference, so it stays smooth on slow phones. |
| Processing | As long as it takes | All the rest of the inference: see [the cost table](#what-processing-costs). |

Processing is not time-boxed — it runs until every recorded frame has been examined, which is why the progress counter matters.

### 0. Waiting for the models, if it comes to that

The embedder and the [recogniser](identification.md#the-re-identification-embedding-reidjs) are optional, so the lobby does not wait for them — it opens on the camera and the object detector alone ([App flow → What Continue actually waits for](app-flow.md#what-continue-actually-waits-for)). Enrolment is the one screen that does have to care, because a scan without them does not *fail*: it quietly enrols weaker signatures, and that gallery is then cached under `SCAN_CACHE_VERSION` and matched against by every phone for the rest of the round. A faster scan that enrols a worse gallery is a bad trade, and the damage persists.

So `runAutoScan()` waits for whatever is still outstanding before the countdown — never during the recording, so a rotation already under way is never interrupted — showing *"Finishing the embedder and the recogniser load..."*. In practice this is instant: reaching the scan screen takes a deliberate tap, which these downloads usually outlast. A 20 s cap (`SCAN_MODEL_WAIT_MS` in `camera.js`) means a download that stalled with no error degrades the scan rather than leaving the player stuck with nothing but the ✕.

### 1. Countdown

`runAutoScan()` clears any previous gallery and counts down from 3, re-rendering every 120 ms, so the player can get into position. The screen shows a large digit plus *"&lt;name&gt;: stand fully visible and face the camera. Start turning slowly when recording begins."*

The render loop draws a green box round whoever the scan would use, which is the confirmation that the player is in fact fully visible. That preview is the object detector alone, on the same 512-wide copy gameplay detects on, at most every 150 ms (`SCAN_PREVIEW_DETECT_INTERVAL_MS` in `screens/game.js`) — it is a highlight, not a measurement, and nothing but `drawScan` ever reads it.

### 2. Recording

`recordRotationVideo()` loops until 12 seconds have elapsed. Each iteration yields to the renderer, copies the current video frame onto a fresh in-memory canvas scaled to at most 1024 px wide (`ROTATION_FRAME_MAX_WIDTH`), then waits `ROTATION_RECORD_FRAME_MS` (180 ms). With the renderer yield on top of that wait, the real period is nearer 195 ms, so a full recording is **about 60 frames**, not the 66 the constants alone suggest.

Nothing is analysed during recording. The point is that the player gets a steady 12 seconds to turn, with no inference competing for the main thread and no dropped frames midway through the rotation. `recordRotationVideo()` sets `state.recordingScan` for the duration, which is what suppresses the preview detection above: the player has been told to turn in a circle, so the box is behind them and nobody is looking at the screen.

> This paragraph described the intent long before the code matched it. The preview detection used to run `detectScanPeople` — object detector **plus** pose landmarker — on the **full-resolution** video on every single video frame, through both the countdown and the recording: roughly 180 object and 180 pose inferences at ~0.92 Mpx, more than the whole processing pass below, none of it reaching the gallery. It also competed with the frame capture for the main thread and left the phone thermally throttled by the time processing started. The cost table below never counted any of it.

All ~60 canvases are held in memory for the whole scan — a few megabytes of backing store each at phone camera resolutions, so a couple of hundred MB in total. They have to be: selection happens after the loop, and the chosen samples are then re-read from their original frames for their thumbnail and their embedding.

### 3. Per-frame analysis

`processRotationVideo()` walks the recorded frames. For each one:

1. **Detect.** `detectRotationFrameBoxes()` draws the frame onto a reused canvas at most 512 px wide (`SCAN_DETECT_MAX_WIDTH`) and runs the object detector on that, scaling the resulting boxes back to full-frame coordinates. If the object detector found nobody, and only then, it retries with `detectScanPeople()` (object detector **plus** pose landmarker) to rescue the frame.
2. **Gate.** `bestUsableScanCandidate()` assesses every box and keeps the best one that passes every check in the table below. If none pass, it records the problem of the best-looking box and moves on.
3. **Describe.** For the chosen box, `extractSignature()` builds the colour signature and the MobileNet embedding, reading pixels from the **full-resolution** frame, not the 512-wide detection copy.

The loop yields to the renderer every `ROTATION_PROCESS_BATCH` (3) frames rather than every frame, and updates *"Processing recorded rotation... i/N, C usable frames"* as it goes. It checks `state.autoScanning` on every single frame, so cancelling is still immediate.

Thumbnails and re-identification embeddings are **not** computed here — see [Deferred work](#5-deferred-work-and-what-it-saves).

#### Quality gates

Checked in this order; the first failure is the frame's recorded problem. The message column is what `scanProblemMessage()` turns the code into, which the player sees in the lobby if the scan ends up short.

| Check | Problem code | Rule | Player-facing message |
| --- | --- | --- | --- |
| Anything detected | `no-person` | No box at all for this frame | *no person detected* |
| Size | `too-far` | Box height under 18% of the frame (`MIN_SCAN_HEIGHT_RATIO`), or width under 2.5% (`MIN_SCAN_BOX_WIDTH_RATIO`) | *step a little closer* |
| Shape | `partial-body` | Height/width ratio outside 0.65–7.0 (`MIN_SCAN_ASPECT`/`MAX_SCAN_ASPECT`) | *stand straighter or show more of your body* |
| Framing | `edge-clipped` | Box touches a frame edge and is under 42% of frame height (`CLIPPED_OK_SCAN_HEIGHT_RATIO`) | *move fully inside the frame* |
| Detector confidence | `low-confidence` | Score below 0.16 (`SCAN_MIN_DETECTION_SCORE`) | *keep your body clearer in the camera* |
| Brightness | `low-light` / `overexposed` | Mean brightness below 0.08 or above 0.94 | *move into brighter light* / *avoid strong backlight* |
| Contrast | `low-contrast` | Brightness standard deviation below 0.025 | *use a less flat background or better light* |
| Sharpness | `motion-blur` | Mean neighbouring-pixel difference below 0.0035 | *turn a little slower* |

The first three (plus `no-person`) come from `scanBoxProblem()` in `identify.js` and are pure arithmetic on the box. The last four need pixels: `scanImageStats()` draws the middle of the box onto a 32×48 canvas and reads it once, computing brightness, contrast and sharpness together from that single read.

Candidate **quality** — used throughout selection — rewards boxes that are large, tall, near the centre (specifically centred on 50% across, 53% down), confidently detected, contrasty and sharp. It is a score, not a gate: a frame that passes every check still loses to a better-framed one.

### 4. Sample selection

`selectRotationSamples()` turns maybe 40–60 usable frames into a compact, varied gallery.

"Similarity" throughout this step is `signatureSimilarity()`: the mean cosine similarity of the **upper-body histogram, lower-body histogram and grid** only. That is deliberate, and worth understanding — it is the colour features, *not* the re-identification embedding. This step is about spotting *different views of the same person*, and a model trained to be view-invariant would rate every angle alike and defeat the diversity selection. It is also what makes deferring the OSNet work safe: selection genuinely cannot see `reid`.

1. **Remove outliers** (`removeScanOutliers`, skipped when there are 12 or fewer candidates): score each frame by the average similarity of its 4 nearest neighbours, and drop anything below 0.36 (`SCAN_OUTLIER_SIMILARITY`). These are usually a different person who wandered through, or a badly placed box. If that would leave fewer than 12, the step is abandoned and the 12 highest-quality frames are kept instead.
2. **Remove near-duplicates** (`removeScanDuplicates`): walk the frames best-quality-first and keep one only if it is less than 0.992 similar (`SCAN_DUPLICATE_SIMILARITY`) to everything already kept. If that leaves fewer than 12, the un-deduplicated set is used instead. The threshold is this high on purpose — it removes frames that are *all but identical*, not merely similar ones.
3. **If 24 or fewer remain**, they are the samples, one frame each, and step 4 is skipped entirely.
4. **If more than 24 remain**, pick seeds and average:
   - **Diversity weighting** (`selectDiverseRotationSeeds`): greedily pick 24 seeds, each time taking the frame with the best `quality + (1 − closest similarity to an already-picked seed) × 0.42` (`SCAN_DIVERSITY_WEIGHT`). So a slightly worse frame of an angle nobody has yet beats a great frame of an angle already covered.
   - **Averaging** (`averagedRotationSample`): each seed is averaged with up to 3 other frames at least 0.74 similar to it (`SCAN_VIEW_AVERAGE_SIMILARITY`, `ROTATION_SAMPLE_AVERAGE_COUNT` 4 including the seed), ranked by similarity with a small quality tiebreak. `averageSignatures()` averages every vector field, re-normalising all of them except `shape` (which has to stay on its raw scale), which smooths out per-frame sensor noise. The sample keeps the seed's box, thumbnail and timestamp, and the group's mean quality.
5. **Order by view** (`orderRotationSamplesByView`): start with the best-quality sample and repeatedly append the most similar remaining one. This roughly reconstructs the rotation order, which only matters because it makes the thumbnail strip readable.

Note the asymmetry: with ≤24 clean candidates every sample is a single frame, and with >24 every sample is an average of up to 4. Both are valid galleries.

### 5. Deferred work, and what it saves

Two things are computed only for the samples that survived selection, because only those are ever used:

- **Thumbnails.** A 48×64 JPEG, cropped from the seed's frame. They are only ever shown in the thumbnail strip, which only shows chosen samples. Cropped for every sample, including on the failure path, because the strip is the feedback there.
- **The re-identification embedding.** `attachSampleReid()` in [`scan-reid.js`](../../frontend/public/scan-reid.js) runs OSNet on each frame that backs a chosen sample and writes the average into `signature.reid`. A sample averaged from 4 frames gets the average of those 4 frames' embeddings, exactly as before; a single-frame sample gets that frame's embedding. A frame shared between two samples is embedded once and reused. Skipped entirely when the scan is already too short to be usable, and when `state.reid` is null because the model failed to load.

  The embeddings are **dispatched four at a time** (`REID_DISPATCH_BATCH`) with a renderer yield between batches, rather than one at a time with a yield in front of each. `reid.js` runs OSNet in a Web Worker (`ort.env.wasm.proxy`) and queues one inference at a time internally, so the only main-thread cost of an `embed()` call is the crop it snapshots synchronously before handing over — which meant the old shape left the worker idle for most of a renderer frame per embedding, about half a second of nothing across a 30-frame scan. Batching keeps the worker fed; the batch size is only about how long an uninterrupted run of snapshots may be. What lands in the gallery is identical, and `test/scan-reid.test.js` embeds a fixed fixture through both this and a serial reference and compares the vectors, because that is the regression that would matter.

This ordering is what makes the embedding affordable. OSNet is the single most expensive inference in the app, and selection cannot see its output, so embedding every usable frame meant paying for it on every frame that selection then threw away. The gallery is unchanged — the same frames are embedded and averaged the same way — but far fewer frames are embedded.

#### What processing costs

Measured by driving the real `processRotationVideo()` over 60 synthetic recorded frames, all of them usable, selecting 24 samples backed by 30 distinct frames:

| Per scan | Before `scan-optimisation` | After `scan-optimisation` |
| --- | --- | --- |
| Object detector inferences | 60, on a 720×1280 (~0.92 Mpx) frame | 60, on a 512×910 (~0.47 Mpx) copy |
| Pose landmarker inferences | 60, same full-size frame | **0** — only frames the object detector found nobody in |
| MobileNet embeddings | 60 | 60 (unchanged; it wants the good pixels) |
| **OSNet re-identification inferences** | **60** | **30** |
| JPEG thumbnail encodes | 60 | 24 |
| `getImageData` calls | 300–360 | 270 |
| Pixels read back via `getImageData` | ~2.11 M | ~1.13 M |
| Renderer yields | 60 | 50 (20 in the loop, 30 in the embedding pass) |

Total model inferences in the processing pass: **240 → 150**, and the two classes that shrank are the two most expensive per call. (The `getImageData` range before the change is because `detectScanPeople` returned an object box *and* a pose box, so the quality gates sometimes read stats for two boxes per frame instead of one.)

#### What the rest of the scan costs

That table only ever covered `processRotationVideo()`. Counting the whole scan screen, which is what the player actually waits through:

| Per scan | Before `startup-latency` | After |
| --- | --- | --- |
| Preview object detector inferences | ~180, on the **full-resolution** video | ~20, on a 512-wide copy, countdown only |
| Preview pose landmarker inferences | ~180, same full-resolution video | **0** |
| Processing-pass inferences | 150 | 150 (unchanged) |
| **Model inferences per scan, total** | **~510** | **~170** |
| Renderer frames in which OSNet is idle waiting to be given work | ~30 | ~8 |

The preview counts are a rate estimate, not a measurement: the old code ran once per *new video frame*, so the real number depends on the camera's frame rate and on how long each full-resolution object+pose pair took on that particular phone — the two fight each other, which is why it is a range in the field. On a 30 fps camera where the pair costs ~80 ms the loop self-limits to about 12 pairs a second, hence ~180 across 15 seconds. The direction is not in doubt even if the exact figure is.

With `?debug`, `scanCostLine()` puts the **actual** counts and per-phase timings on the overlay after every scan, so this can be read off a real phone rather than estimated: see [Debug mode](../development/debug-mode.md#startup-and-scan-costs).

#### What was considered and rejected

**Moving the MobileNet embedding after selection**, the way OSNet's was. Selection genuinely cannot see `signature.embed` — `signatureSimilarity()` averages `hist`, `lower` and `grid` only — so this is sound in principle, and it is the obvious next move. It does not pay here. MobileNet runs on every *usable* frame, ~55 of 60; the frames backing the chosen samples are ~30 of those; so the saving is ~55 → ~30 embeddings. But there is no way to ask `identify.js` for *only* the embedding of a frame — `personEmbedding()` is private, and `extractSignature()` computes the colour features and the embedding together or neither (`appearance: false` skips both). So the deferred pass would have to call `extractSignature()` again for each of ~30 frames, recomputing colour features that were already computed and thrown away, including three `getImageData` read-backs each. Trading ~25 MobileNet inferences for ~30 redundant colour-feature extractions is not obviously a win and may be a loss. Doing it properly needs a narrower seam in `identify.js`.

**OSNet's threads.** `reid.js` asks for `min(4, hardwareConcurrency)` WASM threads, but only when `crossOriginIsolated` — which needs COOP and COEP on the document. Nothing served them until `frontend/cross-origin-isolation.conf`, so until then OSNet ran single-threaded on every device and the threaded WASM build in the image was doing the plain build's work. The inferences dominate the embedding pass, so this was the largest remaining win here, and it was a header change rather than a code change. The actual speedup is **not yet measured on a phone**; `?debug` reports the thread count and the per-scan inference timings.

How the OSNet figure holds up, since it is the headline: the count after the change is the size of the union of the backing sets of the 24 chosen samples. That is bounded above by `24 × 4 = 96` and by the number of clean candidates, so with ~60 frames the bound alone guarantees nothing — it had to be measured. Running the real `selectRotationSamples()` over synthetic rotations (colourful, neutral and high-contrast outfits, 24–66 usable frames) the union **saturates at 27–30 frames** once there are more than ~40 candidates, because the 24 seeds' neighbour groups overlap heavily. It is also guaranteed never to be *worse*: every backing frame is a candidate, and each is embedded at most once.

One case costs more than before: a scan where the object detector keeps finding nobody — the player out of frame, or far too dark — pays two object-detector passes plus a pose pass on each of those frames, instead of one of each. That scan was going to fail its 12-sample floor anyway, and it buys the good scans a pose inference saved on every frame.

The resolution change is more modest than it looks. EfficientDet-Lite0, the pose landmarker and MobileNetV3 all resize their input to a fixed internal size, so detecting on a 512-wide copy instead of a 1024-wide one does **not** reduce the network's work — it reduces the per-inference image upload and internal resize by 4×, at the cost of one extra `drawImage` per frame. The pose-landmarker and OSNet reductions are the real wins.

### 6. Result

- **12 or more samples** (`SCAN_MIN_SAMPLES`): the gallery is cached in `localStorage`, sent to the server as `{type: 'scan', targetId, gallery}`, and the phone returns to the lobby with *"Saved scan for &lt;name&gt; with N angles."* If the scanned player is the local one, the gallery is also kept in `state.localGallery`.
- **Fewer than 12:** the phone returns to the lobby with *"Only got N/12 usable angles from U/T frames: &lt;hint&gt;. Try again slower."* — where `U` is usable frames, `T` total recorded, and the hint is the message for the **most frequent** problem code (`mostCommonProblem`), falling back to the last one seen. Nothing is sent or cached. The player-facing version of this list is in [How to play](../how-to-play.md#scanning-a-player).
- **An exception anywhere** in recording or processing: *"Could not process the rotation video: &lt;error&gt;."* A failed OSNet inference lands here, so one model error fails the whole scan rather than producing a gallery with some embeddings missing.

## What a gallery sample contains

A gallery is an array of signature objects — exactly what `extractSignature()` produces, with `reid` added afterwards. Nothing else from the scan (boxes, quality scores, frame timestamps, source frames) leaves `scan.js`.

| Field | Length | Used for |
| --- | --- | --- |
| `hist` | 64 | Upper-body colour. **Both** sample selection (via `signatureSimilarity`) and live matching. The main angle-invariant colour signal. |
| `lower` | 64 | Lower-body colour. Selection and live matching. A false-positive guard: a similar shirt is not enough if the trousers differ. |
| `grid` | 192 | Coarse colour/shape grid. Selection and live matching. Changes with viewing angle, which is exactly why selection uses it to tell angles apart. |
| `shape` | 2 | Box proportions, stored **raw** rather than L2-normalised like the rest (it is compared as a log ratio of aspects, so its scale carries meaning — see [Identification → Signatures](identification.md#signatures)). Live matching only, as a guard — **not** part of `signatureSimilarity`, so it has no say in which samples are chosen. |
| `embed` | 256, or `[]` | MobileNet embedding. Live matching only, blended with the colour parts when no `reid` is available on both sides. Not used by selection. |
| `reid` | 512, or `[]`/absent | OSNet embedding. Live matching only, where it **overrides** every other field. Not used by selection — this is what makes deferring it safe. |
| `usable` | bool | Whether the box was big and whole enough to trust. Dropped by the server's sanitiser rather than stored. |

The three fields selection actually reads are `hist`, `lower` and `grid`. Everything else is there for the game.

See [Identification → Signatures](identification.md#signatures) for how each vector is computed and [Identification → Comparing a signature to one player](identification.md#comparing-a-signature-to-one-player) for how they are weighed at match time.

## Cancelling

The **✕** button cancels at any point — countdown, recording, per-frame processing or the embedding pass. It sets `state.autoScanning = false` and returns to the lobby with *"Scan cancelled."*

Every loop in the scan path checks that flag on each iteration and returns `null` rather than a partial result, and `runAutoScan()` only touches `state.gallery` once it holds a non-null result. So a cancel can never leave a half-built gallery behind: nothing is sent, nothing is cached, and the player keeps whichever gallery they already had. The `finally` blocks notice `state.mode` is no longer `'scan'` and leave the lobby's message alone.

Up to `REID_DISPATCH_BATCH` (4) in-flight OSNet inferences may still finish after a cancel — they are awaited, not abortable — but their results are discarded and no further batch is dispatched. The lobby appears immediately regardless: `cancelScan()` changes the screen synchronously, and the draining happens behind it.

## Local cache

Every scan is cached under `laser-tag:scan:<room>:<lower-cased name>`. When you join, your own cached scan for that room and name is sent with the `join` message, so you are already scanned without rotating again after a reload.

`validScanCache()` rejects a cache unless **all** of these hold:

- `version === SCAN_CACHE_VERSION`
- the name and room both match the current ones
- `gallery` is an array of 12–24 samples
- every sample has `hist`, `lower`, `grid` and `shape` arrays
- `thumbs` is an array

### Why the version exists

A cached gallery is compared against signatures extracted by whatever code is running *now*. If the signature format changes — a new field, different bin counts, a different region of the body, a different weighting — old samples are not merely stale, they are **silently wrong**: cosine similarity against a vector built by different code still returns a number, so matching degrades instead of failing. Bumping `SCAN_CACHE_VERSION` is what forces those caches to be discarded and the player to rescan.

The current version is **12**, which stores `shape` raw instead of L2-normalised. That is a textbook case of the silent failure above: a version-11 `shape` is a unit vector, and the corrected comparison reads it as a wildly wrong aspect ratio rather than failing ([the bug report](../shape-feature-bug.md)). Version 11 was the one whose samples carry a `reid` embedding; bumping to it is what discarded the pre-re-identification caches.

Note that the required-field check does *not* include `reid`. A cache saved on a phone where OSNet failed to load is still valid — it just produces weaker matching for that player, which is the same graceful degradation the live path has.

## Server-side limits

The server keeps at most 24 samples per gallery and truncates each feature vector to a fixed length, including `reid` at 512. `usable` is not in `GALLERY_FIELDS`, so it is dropped. See [Protocol → Gallery format](../server/protocol.md#gallery-format).

## Tuning

All scan constants (`SCAN_*`, `ROTATION_*`) are at the top of `frontend/public/screens/scan.js`. See [Configuration → Scanning](../development/configuration.md#scanning).
