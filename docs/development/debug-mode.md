# Debug mode

Add `?debug` to the URL, e.g. `http://localhost:8080/?debug`. It does three things.

## 1. A debug clone to play against

Your `join` message includes `debug: true`, and the server adds a second player called **"*your name* clone"**. The clone:

- mirrors your scan, so scanning yourself scans it too;
- doesn't block launch;
- can be shot.

So one person with one laptop can scan, launch, and play a full round: point the webcam at yourself (or a photo of yourself) and fire with **Space**. Because the clone has exactly your gallery, the person on camera is identified as the clone and hits are credited to it. See [Game rules → Debug clones](../server/game-rules.md#debug-clones).

A debug session and a normal session for the same room don't resume each other: the saved `activeLobby` records whether it was a debug session.

## 2. The stats overlay

A text overlay shows live numbers. A typical game-screen readout:

```
GPU+Pose+Embed+ReID · 8 fps · 23 ms
1280×720 · 2 people · 2/3 live tracks · 1 identified
Bob:0.78 reid u0.82 l0.77 g0.69 s0.93 e0.61
Range 2box h .41 .14* ≥.18 · ok14 far5
Dist Bob .78@.41
Ranks #4 Bob:0.78/0.21,Alice:0.57/-0.21 | #5 self:0.80/0.22
motion on · from Bob,Alice
Motion #4 Bob confirmed [Bob:0.84,Alice:0.11] | #5 - self
Rejected Alice:0.49 score u0.61 l0.40 g0.52 s0.88 e0.30
```

| Line | Meaning |
| --- | --- |
| 1 | Delegate (`GPU` or `CPU`, plus `+Pose`, `+Embed` and `+ReID` for each optional model that loaded); detection runs per second; time of the last detection in ms |
| 2 | Video resolution; people in the last detection; tracks seen recently / all tracks; tracks identified as another player |
| 3 | Each identified track: name, overall score, the marker `reid` if the [re-identification embedding](../client/identification.md#the-re-identification-embedding-reidjs) decided the match, then **u**pper-body, **l**ower-body, **g**rid, **s**hape and **e**mbedding similarity |
| `Range` / `Dist` | The range readout — [its own section below](#the-range-readout) |
| `Ranks` | Per track (`#id`), the top 3 candidates as `name:score/margin`. `self` is you (the [self-match guard](../client/identification.md#the-self-match-guard)). |
| `motion` | Absent by default, since whatever is identifying people only gets a line if it has something to say and the appearance-only provider doesn't. With `?motion=on` or `?motion=strict`: this phone's sensor (`on`, `no data` or `off`), `strict` if set, and which players' phones are sending motion samples |
| `Motion` | Per track: the fused identity and its reason (`confirmed`, `classifier-only`, `corrected`, `vetoed`, `unconfirmed`, `motion-only`, `ambiguous`, `unrecognised`, `self`), then each player's motion correlation in brackets — or that check's reason when there's no number yet (`not enough data`, `person not moving`, `phone not moving`, `unclear`) |
| `Rejected` | Unidentified tracks with their best rejected candidate, the rejection reason (`score`, `upper`, `lower`, `grid`, `shape`, `margin`, `self`) and the part scores |

"fps" here is detections per second, not screen frame rate. In the game, detection runs every 80–120 ms, and less often if a phone can't keep up, so 7–12 is normal; boxes are moved along between detections.

### The range readout

Two lines that answer one question: **for the people on screen right now, are we failing to detect
them, or detecting them and refusing them?**

Those have opposite fixes. If the detector never returns a box, lowering a threshold buys nothing
and it needs a second region-of-interest detection pass — up to half the detection cadence on a
slow phone. If the detector finds them and `boxQuality()` throws the box away for being under 18 %
of frame height, admitting that band is nearly free. On screen the two are identical: an
unidentified *"Person"*, or nothing at all. Hence the line.

```
Range 2box h .41 .14* ≥.18 · ok14 far5
Dist Bob .78@.41
```

| Field | Meaning |
| --- | --- |
| `2box` | How many boxes the **last detection** returned. From `state.boxes`, not from the tracks, because a track coasts for up to half a second after its box is gone — and "the detector has stopped finding them" is the signal that must never be hidden |
| `h .41 .14*` | Each live box's height as a fraction of frame height, biggest first, at most four. This is the exact quantity the gate compares, so it sits next to the gate |
| *(suffix)* | No suffix: at or above the gate, a box the matcher will score. `*`: under the gate — **detected and refused**. `-`: under the far floor, where no gate change can help. The suffix is computed on the exact ratio, so `.18*` is a box that rounds to `.18` in print but is genuinely below it |
| `≥.18` | The live height gate (`MIN_MATCH_HEIGHT_RATIO`). Appears as `≥.18/.10` once a far floor exists; until then no floor is shown, rather than one being invented |
| `ok14 far5` | `rangeDiagnostics()` tallies **for the last whole second** — reset on the same window as `fps`, so they read "here, at this distance, now" rather than a session total that never comes back down once you walk closer. `ok` passed the gate; `far` was in the far band and refused; `reid` was in the band and allowed through the re-identification path; `low` was under the far floor; `part` and `clip` are the non-distance refusals (`partial-body`, `edge-clipped`). `ok` always shows — `ok0` is the loudest reading there is — and the rest only when non-zero |
| `Dist Bob .78@.41` | Per named track: the re-identification score next to that track's box height. Absent when nobody on screen has a name. A score marked `c` (`Bob c.52@.41`) is the colour blend, not an OSNet cosine — they are different scales and must not be read as one series |

Reading it:

- **At 5 m.** `Range 1box h .45 ≥.18 · ok37` — one box, well above the gate, nothing refused. The
  pipeline is being given everything it needs; if the player is still not named, the problem is
  appearance matching, not range. Look at `Ranks` and `Rejected`.
- **At 25 m, detected.** `Range 1box h .09- ≥.18/.10 · ok0 low41`. The detector *is* finding them.
  The box is nine per cent of frame height and every check is being refused on distance alone, so
  no feature is ever scored. **A gate change is exactly the fix**, and the `-` says the box is
  small enough that even a far floor at 0.10 would not admit it.
- **At 25 m, not detected.** `Range 0box ≥.18/.10 · ok0`. No box at all, so there is nothing for
  any gate to refuse. **A gate change buys nothing** — this is the case that needs the
  region-of-interest pass, and the only case that justifies paying for it.
- **In between, around 15 m.** `Range 1box h .15* ≥.18/.10 · ok0 far9` — in the band, refused.
  `reid9` instead means the band is already being admitted through re-identification.
- **Testing whether score degrades with distance.** Walk backwards watching `Dist`. `Bob .78@.41`
  becoming `Bob .61@.22` and then `Bob .48@.15` is the hypothesis confirmed; a score that holds up
  while the box shrinks says distance is not what is breaking identification.

The readout appears on the **scan screen as well as in a round**, which is the point — the scan
screen is where the camera is up and detecting while you walk around measuring. It is suppressed on
the join and lobby screens, where no detection has run and `state.boxes` would be whatever the last
scan or round left behind: a stale reading looks exactly like a live one.

> **Why `<pre id="debug">` gets moved.** The element is declared inside `#game-screen`
> (`index.html`), which stays `hidden` until a round starts — so the whole overlay was invisible on
> the join, lobby and scan screens even though `join.js` unhides it. Under `?debug` only,
> `screens/game.js` reparents it to `<body>` once and gives it `position: fixed` and a z-index above
> the screens. The tidy fix is to declare it in `<body>` in `index.html` and add those two
> properties to the `#debug` rule in `style.css`; when that happens, the reparenting in
> `debugOverlay()` becomes a no-op and should be deleted.

The implementation is `frontend/public/range-readout.js` — pure, DOM-free and unit-tested
(`test/range-readout.test.js`), reached only from inside the `if (DEBUG)` branch of the frame loop.
`test/range-readout-cost.test.js` holds that last property down, so the readout costs nothing at
all when `?debug` is absent. For the offline counterpart — what admitting smaller boxes does to
accuracy, and why the synthetic answer cannot be trusted — see
[box scale and range](../box-scale-evaluation.md).

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
- **`reid` on line 3:** scores are OSNet cosine similarities against the accept threshold shown on line 1 (`reid ≥ 0.65` by default, `?reid=` to change it); each box also shows its best match in brackets: the typical score (median of the last 3 s, motion included), this check's score as `now` when different, and `motion+0.06`/`motion-0.08` when motion moved it, and the `u`/`l`/`g`/`s`/`e` numbers are informational only — they're computed but not mixed into the score. Without the marker, the score is the colour blend and those parts do count.
- **Rejected for `lower`:** the player's lower body doesn't match the scan (different lighting? jacket on?). For `margin`, two candidates look too similar.
- **`vetoed` or `unconfirmed` in the `Motion` line:** appearance picked someone whose phone isn't moving with them. A real player standing still gives `phone not moving` (which is `unknown`, not a veto); a steady `inconsistent` with a low correlation usually means it's a bystander who looks like that player.

## 3. Extra drawing and logging

- Unidentified people show their best rejected guess in **yellow** with long dashes: *"Alice? 0.49"*.
- A track whose appearance identity was [vetoed by motion](../client/identification.md#fusing-it-with-the-classifier-fusemotion) is labelled *"not Alice (motion)"* instead of plain *"Person"*.
- The console logs every SSE `health`/`death` event and every shot the server rejected (e.g. `Cooldown`, `Round not running`).

## Related flags: `?motion=off` and `?motion=strict`

Independent of `?debug`, and combinable with it. Motion tracking is on by default. `?motion=off` disables it; `?motion=strict` also drops the classifier-only fallback, so a shot counts only when the target's own phone motion confirms who they are. Useful for seeing how often motion actually confirms an identity in a real space: in strict mode, every green name on screen has been confirmed by two independent signals. See [Identification → Motion confirmation](../client/identification.md#motion-confirmation-motion).

Be aware that it makes a single-laptop debug session nearly unplayable: the "clone" on camera is you, and there's only one phone in the room, so nothing can confirm it.

## Testing two players on one machine

Open two browser windows with different names and the same room code (with or without `?debug`). Each is its own player. Both see the same webcam, so for anything beyond a smoke test, a phone as the second player works better.

`scripts/open-chrome.ps1` opens a debug window with the camera prompt auto-accepted. See [Windows helper scripts](../operations/windows-scripts.md#open-chromeps1).
