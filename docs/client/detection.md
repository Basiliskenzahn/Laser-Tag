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

Only the first three run through MediaPipe and are created by `createDetector()`. OSNet is a separate runtime with a separate loader; this page covers the MediaPipe side, and the re-identification model is documented with [identification](identification.md#the-re-identification-embedding-reidjs).

### Loading

`createDetector()`:

1. Loads the WebAssembly fileset.
2. Creates the object detector with the **GPU** delegate, falling back to **CPU** if that fails.
3. Tries to create the pose landmarker and the embedder on the same delegate. If either fails, it logs a warning and carries on without it.
4. Returns `{detector, poseDetector, embedder, delegate}`. `delegate` is a label such as `GPU+Pose+Embed` that the debug overlay shows. `app.js` appends `+ReID` to it when the re-identification model also loaded, so the overlay's first line says exactly which signals are live.

Object detector settings: video mode, score threshold 0.35, up to 8 results, `person` category only.
Pose settings: video mode, up to 8 poses, detection/presence/tracking confidence 0.18.
Embedder settings: video mode, L2-normalised float output.

## Detection functions

Every function returns boxes in source-pixel coordinates: `{x, y, w, h, score, source}` where `source` is `'object'`, `'pose'` or `'zoom'`.

| Function | Used during | What it does |
| --- | --- | --- |
| `detectPeople` | everything | Raw EfficientDet person boxes |
| `detectScanPeople` | scanning | Object boxes **plus** pose boxes, deduplicated (overlap below 0.75 IoU). Generous, so scanning finds the person even in awkward poses. |
| `detectTrackedPeopleFast` | most game frames | Object boxes only, deduplicated (IoU below 0.5 and centres far enough apart) |
| `detectTrackedPeople` | some game frames | Object boxes refined with pose (see below) |
| `detectZoomedPeople` | every 2nd game detection | Object boxes on the central 1/2.5 of the full-resolution frame, for people too far away for the full-frame pass; boxes touching the crop edge are dropped. Merged with the frame's other boxes by `mergeZoomedPeople` (same suppression as `detectTrackedPeopleFast`). See [Detection tuning → Range](../development/detection-tuning.md#range). |

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
| `hitTest(boxes, x, y)` | `'head'`, `'body'` or `null`. Any head hit wins over a body hit. Exported for convenience; the game itself walks tracks and calls `contains()` per hitbox, because it needs to know *which* track was hit, not just the zone. |

The constants (`HEAD_TOP`, `HEAD_HEIGHT`, `HEAD_WIDTH`, `BODY_TOP`, `BODY_HEIGHT`, `BODY_WIDTH`) are at the top of `detector.js`. See [Configuration](../development/configuration.md#hitboxes).

## Performance notes

- In the game, inference runs on a copy of the frame scaled to at most **512 px wide**; boxes are scaled back to full video resolution afterwards. The model itself sees 320×320, which is why far people need the zoom pass; it crops from the full-resolution video, not the 512 px copy.
- Detection runs every **80 ms** while some visible person is still unidentified and every **120 ms** once everyone is identified, but never more often than the last detection's time ÷ 0.7, so a slow phone spends at most ~70% of its time detecting. It does not run on every animation frame; between detections the overlay and the shot move each box along its track's velocity (at most 0.25 s ahead).
- Scanning records frames at up to **1024 px wide** and runs detection on them after recording, not live (see [Scanning](scanning.md)).
