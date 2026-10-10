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
GPU+Pose+Embed · 8 fps · 23 ms
1280×720 · 2 people · 2/3 live tracks · 1 identified
Bob:0.71 u0.82 l0.77 g0.69 s0.93 e0.61
Ranks #4 Bob:0.71/0.15,Alice:0.56/-0.15 | #5 self:0.80/0.22
Rejected Alice:0.49 score u0.61 l0.40 g0.52 s0.88 e0.30
```

| Line | Meaning |
| --- | --- |
| 1 | Delegate (`GPU` or `CPU`, plus `+Pose` and `+Embed` if those models loaded); detection runs per second; time of the last detection in ms |
| 2 | Video resolution; people in the last detection; tracks seen recently / all tracks; tracks identified as another player |
| 3 | Each identified track: name, overall score, then **u**pper-body, **l**ower-body, **g**rid, **s**hape and **e**mbedding similarity |
| `Ranks` | Per track (`#id`), the top 3 candidates as `name:score/margin`. `self` is you (the [self-match guard](../client/identification.md#the-self-match-guard)). |
| `Rejected` | Unidentified tracks with their best rejected candidate, the rejection reason (`score`, `upper`, `lower`, `grid`, `shape`, `margin`, `self`) and the part scores |

"fps" here is detections per second, not screen frame rate. In the game, detection deliberately runs only every 120–180 ms, so 5–8 is normal.

Use this to tune identification: if a player is rejected for `lower`, their lower body doesn't match the scan (different lighting? jacket on?); if for `margin`, two players look too similar.

## 3. Extra drawing and logging

- Unidentified people show their best rejected guess in **yellow** with long dashes: *"Alice? 0.49"*.
- The console logs every SSE `health`/`death` event and every shot the server rejected (e.g. `Cooldown`, `Round not running`).

## Testing two players on one machine

Open two browser windows with different names and the same room code (with or without `?debug`). Each is its own player. Both see the same webcam, so for anything beyond a smoke test, a phone as the second player works better.

`scripts/open-chrome.ps1` opens a debug window with the camera prompt auto-accepted. See [Windows helper scripts](../operations/windows-scripts.md#open-chromeps1).
