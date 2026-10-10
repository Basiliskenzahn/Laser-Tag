# Person detection and hitboxes

`frontend/public/detector.js` finds people in camera frames and turns each one into a head hitbox and a body hitbox. Deciding *who* each person is happens afterwards, in [identification](identification.md).

## Models

All models run in the browser through [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector) (`@mediapipe/tasks-vision` 0.10.35). The model files are committed to `frontend/public/models/` so the game works without internet access.

| Model | File | Role | Loaded by | Required? |
| --- | --- | --- | --- | --- |
| EfficientDet-Lite0 | `efficientdet_lite0.tflite` (7 MB) | Main person detector | `detector.js` | Yes |
| Pose Landmarker Lite | `pose_landmarker_lite.task` (6 MB) | Extra person boxes from body landmarks | `detector.js` | No |
| MobileNetV3 Small embedder | `mobilenet_v3_small_embedder.tflite` (4 MB) | Learned appearance embedding for identification | `detector.js` | No |
| OSNet x0.25 (MSMT17) | `osnet_x0_25_msmt17.onnx` (0.9 MB) | Person re-identification embedding — the strongest identification signal | [`reid.js`](identification.md#the-re-identification-embedding-reidjs), via ONNX Runtime Web | No |

The MediaPipe JavaScript bundle and WebAssembly files aren't committed. They're served from `node_modules/@mediapipe/tasks-vision/` at the URL path `/vendor/tasks-vision/` by nginx. ONNX Runtime Web (pinned alongside it in `package.json`) is served the same way, from `node_modules/onnxruntime-web/dist/` at `/vendor/ort/`.

Only the first three run through MediaPipe, created by `createObjectDetector()`, `createPoseDetector()` and `createEmbedder()` in `detector.js`. OSNet is a separate runtime with a separate loader; this page covers the MediaPipe side, and the re-identification model is documented with [identification](identification.md#the-re-identification-embedding-reidjs).

Note the **Required** column: only the object detector is. Of the 18 MB on this page, 10.9 MB is optional, and [startup](app-flow.md#join-join-screen) is built around that — the lobby opens on the object detector alone and the rest arrive behind it.

### Which model runs when

The two paths that run models — scanning and gameplay — differ in **which** models they use, at **what resolution**, and at **what cadence**. They are easy to confuse, so the whole picture in one place:

| Model | Scan path (`screens/scan.js`) | Gameplay path (`screens/game.js`, `identify.js`) |
| --- | --- | --- |
| **EfficientDet-Lite0** (object detector) | Two separate jobs. **Preview:** the green box on the idle scan screen, at most every **150 ms** (`SCAN_PREVIEW_DETECT_INTERVAL_MS`), on a 512 px copy, and not at all during the recording — ~20 inferences, all during the countdown. **Processing:** every recorded frame, on a copy at most **512 px** wide. ~60 inferences per scan. | Every detection pass, on a copy at most **512 px** wide (`GAME_DETECT_MAX_WIDTH`). Every **120 ms** while a visible person is unidentified, **180 ms** once everyone is identified, plus on any shot needing a fresh detection. |
| **Pose Landmarker Lite** | **Rescue only.** Runs on a recorded frame solely when the object detector found nobody in it, so ~0 inferences on a well-framed scan. Never in the preview. | Every **520 ms** at most, and only once the room has at least two scanned players (`rosterCandidateCount() >= 2`), plus on a shot that forces it. Same 512 px copy. |
| **MobileNetV3 Small** (embedder) | Every *usable* frame during processing, reading the **full-resolution** (up to 1024 px) frame. Up to ~60 inferences per scan. | Inside `extractSignature()` on each due identity check, reading the **full-resolution** video. Per track: every detection for its first 6 checks (`SETTLE_CHECKS`), then every **250 ms** (`RECHECK_MS`). |
| **OSNet x0.25** (re-identification) | Once per frame backing a chosen gallery sample, **after** selection, reading the full-resolution frame. ~30 inferences per scan, dispatched **four at a time** into reid.js's worker ([`scan-reid.js`](scanning.md#5-deferred-work-and-what-it-saves)). | Fire-and-forget: each due identity check calls `reid.request(track, …)` and uses whatever `reid.latest(track)` already has (max age 800 ms). One inference at a time; a repeat request for a pending track is dropped. |

Two differences are worth spelling out, because they are the ones people get wrong:

- **Detection is downscaled on both paths; description is not.** Both paths detect on a 512-wide copy and then read pixels for signatures from the full-resolution source. The models resize their input internally anyway, so the downscale saves the per-inference upload, not network work; the signature genuinely wants the better pixels.
- **Scanning awaits OSNet; gameplay never does.** Enrolment has no frame deadline and every gallery sample needs an embedding, so it blocks. The game cannot block, so it uses the previous result and skips the check entirely when there isn't a recent one. See [Identification → Waiting for a re-identification embedding](identification.md#3-waiting-for-a-re-identification-embedding).

Nothing runs on every animation frame on either path. That is recent: the scan screen's preview detection used to, and through `detectScanPeople` on the **full-resolution** video, which meant roughly 180 object and 180 pose inferences at ~0.92 Mpx across a scan's countdown and recording — more than the entire processing pass that follows, for a highlight box. It is now the throttled object-only pass in the table above.

The only inference outside those two paths is `camera.js`'s one-off [warm-up](app-flow.md#join-join-screen): each of the four models is run exactly once, on a blank or 512-wide throwaway frame, as soon as it loads, so the round does not pay for the first-inference shader compile.

### Loading

`detector.js` exposes one factory per model rather than one function that loads all three, because the three are not equally urgent and [`startup.js`](app-flow.md#join-join-screen) needs to say so:

1. `createVisionFileset()` loads the WebAssembly fileset, shared by all three.
2. `createObjectDetector(fileset)` creates the object detector with the **GPU** delegate, falling back to **CPU** if that fails, and returns `{detector, delegate}`.
3. `createPoseDetector(fileset, delegate)` and `createEmbedder(fileset, delegate)` take that same delegate, so the three can never end up split across GPU and CPU. Each returns `null` rather than throwing if this phone could not manage it, logging a warning.

That delegate hand-off is the one real ordering constraint in startup: whether MediaPipe can use the GPU at all is only discovered by trying, and the try that counts is the object detector's, because that is the model the game runs every frame. `startup.js` starts pose and the embedder from a single continuation on that answer, so the two overlap with each other but neither begins before it.

`camera.js` assembles the debug overlay's delegate label — `GPU`, plus `+Pose`, `+Embed` and `+ReID` for each optional model that actually loaded — and rebuilds it each time one lands, since they no longer arrive together.

Object detector settings: video mode, score threshold 0.35, up to 8 results, `person` category only.
Pose settings: video mode, up to 8 poses, detection/presence/tracking confidence 0.18.
Embedder settings: video mode, L2-normalised float output.

## Detection functions

Every function returns boxes in source-pixel coordinates: `{x, y, w, h, score, source}` where `source` is `'object'` or `'pose'`.

| Function | Used during | What it does |
| --- | --- | --- |
| `detectPeople` | every recorded scan frame; underneath all the others | Raw EfficientDet person boxes |
| `detectScanPeople` | a scan frame the object detector found nobody in | Object boxes **plus** pose boxes, deduplicated (overlap below 0.75 IoU). Generous, so scanning finds the person even in awkward poses. |
| `detectTrackedPeopleFast` | most game detection passes | Object boxes only, deduplicated (IoU below 0.5 and centres far enough apart) |
| `detectTrackedPeople` | some game detection passes | Object boxes refined with pose (see below) |

`detectScanPeople` is the generous one, but scanning no longer spends it on every frame. Because a scan is one cooperative subject who was asked to stand fully visible, `scan.js` calls `detectPeople` per frame and only falls back to `detectScanPeople` when that returned nothing — which costs a second object-detector pass on an empty frame, and saves a pose inference on every other frame. See [Scanning → Per-frame analysis](scanning.md#3-per-frame-analysis).

### Pose-assisted detection

The object detector sometimes merges two people standing close together into one box, or misses someone. `detectTrackedPeople` uses confident pose boxes (score ≥ 0.55) to fix both:

- **Splitting:** if an object box contains two or more pose boxes whose centres are offset from it, the object box is dropped in favour of the pose boxes.
- **Filling in:** a pose box that doesn't overlap any object box is added as an extra person.

The pose model is slower, so in the game it only runs when the room has at least two scanned players (counting yourself), and then at most every 520 ms, plus on any shot that triggers a fresh detection.

### Pose boxes

`poseBoxes()` turns each pose's landmarks into a box: it keeps landmarks with visibility ≥ 0.2 inside the frame (with a small margin), needs at least 6 of them, takes their bounding box, and pads it so it roughly matches an object-detector box (more padding below, to cover the feet). The box's `score` is the fraction of landmarks that were visible.

## Hitboxes

Detector boxes are loose: they include outstretched arms and empty space. Hitboxes are deliberately tighter, defined as fractions of the person box:

```
          ┌──────── person box ────────┐
   2%  →  │        ┌──head──┐          │
          │        │  34%w  │          │   head: 34% of width, centred,
  20%  →  │        └────────┘          │         from 2% to 20% of height
  22%  →  │     ┌─────body─────┐       │
          │     │              │       │   body: 56% of width, centred,
          │     │    56% w     │       │         from 22% to 94% of height
          │     │              │       │
  94%  →  │     └──────────────┘       │
          └────────────────────────────┘
```

| Function | Purpose |
| --- | --- |
| `headBox(box)` | Head hitbox |
| `bodyBox(box)` | Body hitbox |
| `contains(box, x, y)` | Point-in-box test |

The game walks its tracks and calls `contains()` per hitbox itself, because it needs to know *which* track was hit, not just which zone.

The constants (`HEAD_TOP`, `HEAD_HEIGHT`, `HEAD_WIDTH`, `BODY_TOP`, `BODY_HEIGHT`, `BODY_WIDTH`) are at the top of `detector.js`. See [Configuration](../development/configuration.md#hitboxes).

## Performance notes

See [Which model runs when](#which-model-runs-when) for the full per-path picture. The short version:

- **Both paths detect on a copy of the frame scaled to at most 512 px wide**, with boxes scaled back to full resolution afterwards (`GAME_DETECT_MAX_WIDTH` in `screens/game.js`, `SCAN_DETECT_MAX_WIDTH` in `screens/scan.js`). The MediaPipe models resize their input to a fixed size internally, so this saves the per-inference image upload and resize rather than any network work.
- In the game, detection runs every **120 ms** while some visible person is still unidentified and every **180 ms** once everyone is identified — but never more often than the last detection's own time ÷ 0.7, so a struggling phone stretches its own interval instead of spending more than ~70% of its time detecting (`DETECT_MAX_BUSY_SHARE`). It does not run on every animation frame; between detections the overlay and the shot move each box along its track's velocity, at most 0.25 s ahead (`liveBox`).
- The pose landmarker is the expensive extra on both paths, and both paths ration it: the game runs it at most every **520 ms** and only with two or more scanned players; scanning runs it only on frames where the object detector found nobody.
- Scanning records frames at up to **1024 px wide** and runs every model on them *after* recording, not live, so the 12-second rotation itself is inference-free (see [Scanning](scanning.md#2-recording)). Signatures are read from those full-resolution frames even though detection used the 512-wide copy.
