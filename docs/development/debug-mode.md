# Debug mode

Add `?debug` to the URL, e.g. `http://localhost:8080/?debug`. It does three things.

## 1. A debug clone to play against

Your `join` message includes `debug: true`, and the server adds a second player called **"*your name* clone"**. The clone:

- mirrors your scan, so scanning yourself scans it too;
- doesn't block launch;
- can be shot.

So one person with one laptop can scan, launch, and play a full round: point the webcam at yourself (or a photo of yourself) and fire with **Space**. Because the clone has exactly your gallery, the person on camera is identified as the clone and hits are credited to it. See [Game rules → Debug clones](../server/game-rules.md#debug-clones).

## 2. The stats overlay

A text overlay shows live numbers. A typical game-screen readout:

```
GPU+Pose+Embed+ReID · draw 58 fps · det 19/20 · id 10/10 Hz · 23 ms · reid ≥ 0.65
1280×720 · 2 people · 2/3 live tracks · 1 identified
Bob:0.78 reid u0.82 l0.77 g0.69 s0.93 e0.61
Ranks #4 Bob:0.78/0.21,Alice:0.57/-0.21 | #5 self:0.80/0.22
Rejected Alice:0.49 score u0.61 l0.40 g0.52 s0.88 e0.30
```

| Line | Meaning |
| --- | --- |
| 1 | Delegate (`GPU` or `CPU`, plus `+Pose`, `+Embed` and `+ReID` for each optional model that loaded); then the three rates — [see below](#the-three-rates); then the last detection's own time in ms, and the re-identification accept threshold |
| 2 | Video resolution; people in the last detection; tracks seen recently / all tracks; tracks identified as another player |
| 3 | Each identified track: name, overall score, the marker `reid` if the [re-identification embedding](../client/identification.md#the-re-identification-embedding-reidjs) decided the match, then **u**pper-body, **l**ower-body, **g**rid, **s**hape and **e**mbedding similarity |
| `Ranks` | Per track (`#id`), the top 3 candidates as `name:score/margin`. `self` is you (the [self-match guard](../client/identification.md#the-self-match-guard)). |
| `Rejected` | Unidentified tracks with their best rejected candidate, the rejection reason (`score`, `upper`, `lower`, `grid`, `shape`, `margin`, `self`) and the part scores |

### The three rates

Line 1 used to carry a single number called `fps`. It meant *detections* per second, it was read as
screen frame rate, and that ambiguity is how taking the forced detection off the shot path looked
like a frame-rate regression when it was not one — removing it genuinely lowered the displayed
number, because a forced detection counted as a detection. There are now three numbers and each
says what it is.

```
draw 58 fps · det 19/20 · id 10/10 Hz lost
```

| Field | Meaning |
| --- | --- |
| `draw 58 fps` | Animation frames per second: how smooth the overlay actually is, and the only one of the three a player would call "fps". The boxes are redrawn every frame from `liveBox()`'s velocity projection, so this stays near the display rate however slowly detection runs. If it dips while `det` holds up, a detection is starving the draw — the same main-thread contention as button lag |
| `det 19/20` | Detections per second, achieved against the target. 20 is the searching target (a 50 ms interval); the target shown is always the searching one, so `det 10/20` in the settled tier is expected and fine — the tier suffix says which |
| `id 10/10 Hz` | Identification checks per live track per second, achieved against `RECHECK_MS`. Measured, not derived: it is the share of (track, cycle) pairs that were a real check, at the rate those cycles happened. `-` until something has been on screen |
| *(tier suffix)* | Why the loop is running at the rate it is: `lost` (a live track the detector missed this cycle — fast tier, pose relaxed), `acquiring` (a live track with no identity — fast tier), or absent (everything found and named — settled tier, 10 fps) |

Reading it:

- **`det` well under target with `ms` over ~35.** The duty cap is holding the rate down, which is
  correct behaviour and not a bug: detection may use at most 70% of the main thread
  (`DETECT_MAX_BUSY_SHARE`), so 50 ms per detection settles at a 71 ms interval and 70 ms at
  100 ms. The phone is as fast as it can be without starving the button.
- **`det` under target with `ms` small.** Then the cap is not the limit and the camera probably is:
  the loop only detects on a video frame it has not seen, so a 15 fps camera caps detection at
  15 fps whatever the interval asks for.
- **`id` under target while `det` is at target.** Identification is being throttled by `RECHECK_MS`
  rather than by the loop. Expected in the settled tier, where detection is 10 fps and a check is
  due on every one of them.
- **A `lost` tier that will not clear.** The detector keeps losing somebody who is on screen. That
  is the case the fast tier and the relaxed pose interval exist for; if it persists, it is a
  detection-quality problem (light, distance, framing), not a cadence one.

### Startup and scan costs

Two more lines are appended to the overlay, both one-off, both absent until the thing they measure has happened.

```
Startup cam 310ms · wasm 190ms · obj 980ms · pose 760ms · embed 540ms · reid 410ms → lobby 1.3s · all 2.1s
Scan 54/60 usable · obj 66 pose 6 embed 54 reid 30 jpeg 24
  rec 12.1s · proc 8.4s · sel 210ms · thumb 90ms · reid 3.2s
```

| Line | Meaning |
| --- | --- |
| `Startup` | `cam` and `wasm` are measured from the start of startup; `obj`, `pose`, `embed` and `reid` are each model's **own** create call, so they can be compared with each other — `pose` and `embed` overlap in wall-clock terms, which is the point. `lobby` is the total to the lobby actually being on screen, and `all` the total to nothing still loading. The gap between those two is the work that used to be in front of the player and now isn't. From `startupTimingLine()` in `startup.js`; also logged once with `console.debug`. |
| `Scan` | Actual inference counts for the last scan, per model, plus usable/recorded frames and JPEG thumbnail encodes. `obj` includes the second pass each [pose rescue](../client/scanning.md#3-per-frame-analysis) costs. Preview detections during the countdown are **not** counted here. |
| `  rec … reid` | Wall-clock per phase: recording, the per-frame detect+describe loop, selection, thumbnails, and the OSNet pass. From `scanCostLine()` in `screens/scan.js`; also logged once per scan. |

Use these to check the two things that are easy to get wrong:

- **`lobby` much larger than `obj` + `cam`:** something has been put back in front of the lobby that does not belong there. The lobby needs the camera and the object detector and nothing else — see [What Continue actually waits for](../client/app-flow.md#what-continue-actually-waits-for).
- **`pose` + `embed` ≈ their sum rather than overlapping:** they are being created serially again. They must wait for the object detector's delegate, but not for each other.
- **A `Scan` line with a non-trivial `pose` count:** the pose landmarker is rescue-only during processing, so a high count means the object detector is losing the player on many frames — usually bad framing or bad light, and the scan is probably about to fail its 12-sample floor.

Use this to tune identification:

- **No `+ReID` on line 1:** the ONNX model didn't load, and matching is running on the much weaker colour signature. Check the console and that `/vendor/ort/` and `/models/osnet_x0_25_msmt17.onnx` are being served.
- **`reid` on line 3:** scores are OSNet cosine similarities against the accept threshold shown on line 1 (`reid ≥ 0.65` by default, `?reid=` to change it); each box also shows its best match in brackets: the typical score (median of the last 3 s) and this check's score as `now` when different, and the `u`/`l`/`g`/`s`/`e` numbers are informational only — they're computed but not mixed into the score. Without the marker, the score is the colour blend and those parts do count.
- **Rejected for `lower`:** the player's lower body doesn't match the scan (different lighting? jacket on?). For `margin`, two candidates look too similar.

## 3. Extra drawing and logging

- Unidentified people show their best rejected guess in **yellow** with long dashes: *"Alice? 0.49"*.
- The console logs every SSE `health`/`death` event and every shot the server rejected (e.g. `Cooldown`, `Round not running`).

## Testing two players on one machine

Open two browser windows with different names and the same room code (with or without `?debug`). Each is its own player. Both see the same webcam, so for anything beyond a smoke test, a phone as the second player works better.

`scripts/open-chrome.ps1` opens a debug window with the camera prompt auto-accepted. See [Windows helper scripts](../operations/windows-scripts.md#open-chromeps1).
