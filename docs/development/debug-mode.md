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
| `Ranks` | Per track (`#id`), the top 3 candidates as `name:score/margin`. `self` is you (the [self-match guard](../client/identification.md#the-self-match-guard)). |
| `motion` | This phone's sensor (`on`, `no data` or `off`), `strict` if `?motion=strict` is set, and which players' phones are sending motion samples |
| `Motion` | Per track: the fused identity and its reason (`confirmed`, `classifier-only`, `corrected`, `vetoed`, `unconfirmed`, `motion-only`, `ambiguous`, `unrecognised`, `self`), then each player's motion correlation in brackets — or that check's reason when there's no number yet (`not enough data`, `person not moving`, `phone not moving`, `unclear`) |
| `Rejected` | Unidentified tracks with their best rejected candidate, the rejection reason (`score`, `upper`, `lower`, `grid`, `shape`, `margin`, `self`) and the part scores |

"fps" here is detections per second, not screen frame rate. In the game, detection deliberately runs only every 120–180 ms, so 5–8 is normal.

Use this to tune identification:

- **No `+ReID` on line 1:** the ONNX model didn't load, and matching is running on the much weaker colour signature. Check the console and that `/vendor/ort/` and `/models/osnet_x0_25_msmt17.onnx` are being served.
- **`reid` on line 3:** scores are OSNet cosine similarities against a 0.72 accept threshold, and the `u`/`l`/`g`/`s`/`e` numbers are informational only — they're computed but not mixed into the score. Without the marker, the score is the colour blend and those parts do count.
- **Rejected for `lower`:** the player's lower body doesn't match the scan (different lighting? jacket on?). For `margin`, two candidates look too similar.
- **`vetoed` or `unconfirmed` in the `Motion` line:** appearance picked someone whose phone isn't moving with them. A real player standing still gives `phone not moving` (which is `unknown`, not a veto); a steady `inconsistent` with a low correlation usually means it's a bystander who looks like that player.

## 3. Extra drawing and logging

- Unidentified people show their best rejected guess in **yellow** with long dashes: *"Alice? 0.49"*.
- A track whose appearance identity was [vetoed by motion](../client/identification.md#fusing-it-with-the-classifier-fusemotion) is labelled *"not Alice (motion)"* instead of plain *"Person"*.
- The console logs every SSE `health`/`death` event and every shot the server rejected (e.g. `Cooldown`, `Round not running`).

## A related flag: `?motion=strict`

Independent of `?debug`, and combinable with it. It drops the classifier-only fallback, so a shot counts only when the target's own phone motion confirms who they are. Useful for seeing how often motion actually confirms an identity in a real space — in strict mode, every green name on screen has been confirmed by two independent signals. See [Identification → Motion confirmation](../client/identification.md#motion-confirmation-motion).

Be aware that it makes a single-laptop debug session nearly unplayable: the "clone" on camera is you, and there's only one phone in the room, so nothing can confirm it.

## Testing two players on one machine

Open two browser windows with different names and the same room code (with or without `?debug`). Each is its own player. Both see the same webcam, so for anything beyond a smoke test, a phone as the second player works better.

`scripts/open-chrome.ps1` opens a debug window with the camera prompt auto-accepted. See [Windows helper scripts](../operations/windows-scripts.md#open-chromeps1).
