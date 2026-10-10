# Detection and identification tuning

How the game decides that the person under your crosshair is a particular player, what has been tuned, what was measured, and how to keep tuning it in the field. The individual constants are listed in [Configuration](configuration.md); the full mechanism is in [Player identification](../client/identification.md) and [Person detection](../client/detection.md).

## The pipeline in one paragraph

Each detection, the object detector finds people (`detector.js`), with a second, magnified pass around the crosshair for far people. The tracker (`identify.js`) follows each person across frames and compares their re-identification embedding (OSNet, `reid.js`) with every player's scan. The comparison gives a score per player, from 0 to 1. A person is named after their **typical score** for a player (the median of the last 3 seconds of checks, adjusted for motion) clears the **threshold** on two agreeing checks. A shot counts once the name has been held for 150 ms and the typical score is still above the threshold. Phone motion (`motion-identity.js`) raises or lowers that score and can veto a shot.

## Tuning in the field

Everything below can be changed from the address bar, with no redeploy:

| Parameter | Effect |
| --- | --- |
| `?debug` | Shows the threshold on the first overlay line (`reid ≥ 0.65`), and on every box the best-matching player and score, e.g. `[David 0.74 (now 0.68) motion+0.06]`: the typical score, this check's score when different, and the motion part when there is one. |
| `?reid=0.68` | Sets the threshold for this phone (0.40–0.95). Every phone in a game should use the same value. |
| `?motion=off` | Disables motion: no sensor prompt, appearance alone decides. Use it to check whether motion is causing missed shots. |
| `?motion=strict` | A shot only counts when the target's own phone motion confirms them. |

To pick a threshold:

1. Open the game with `?debug` on every phone.
2. Point at players and at non-players, from the distances you actually play at, and note the scores on their boxes.
3. Set `?reid=` between the two groups. If they overlap, no threshold separates them; motion is what separates the overlap, so ask people to move.

Scores depend on the room, the light and the phones, so it's worth repeating this whenever the venue changes. A rescan in the playing area raises players' scores more than any threshold change.

## What was tuned, and why

### The threshold

Real phones score players lower than the Market-1501 benchmark the threshold was first picked on, because every scan comes from another phone, in other light. Field tests on this branch:

| Threshold | Result |
| --- | --- |
| 0.72 | Too many false positives (before the gate fix below, which means the effective threshold was ~0.62) |
| 0.80 | No false positives, but nobody was recognised |
| 0.76 | Better, but players were often missed |
| 0.70 | With the 3 s median: players 0.70–0.80+, non-players 0.60–0.65; no false positives |
| 0.68 | No false positives, faster recognition |
| **0.65** (default) | Very few false positives, fewer missed players |

Two fixes made the threshold mean what it says:

- **Every gate follows it.** Evidence (from a fixed 0.62), tentative names (0.66) and shots (0.70) used to ignore the threshold, so raising it barely changed anything. They were then tied to it with small allowances below it. With the median, those allowances aren't needed any more: at 0.65 they reached into the non-player range and let someone who usually scores 0.63 get named. Now every gate is the threshold itself.
- **Decisions use the typical score, not the latest check** (`REID_HISTORY_MS`, 3 s median per player). A brief spike from someone who usually scores 0.60–0.65 doesn't name them; a single dip from a player who usually scores 0.80+ doesn't cost them their name or the shot. Revoking a name still reacts to the latest checks: three in a row below 0.6 drop it, so someone stepping into a player's box is caught quickly.

### Motion

Motion is on by default. It does two things:

- **It moves the score.** If a player's phone moves the way the person on screen moves, that person's typical score for the player gets +0.06. If the movement clearly contradicts it, the score gets −0.08 (`MOTION_SCORE_BONUS`, `MOTION_SCORE_PENALTY`). This widens the gap between players and non-players whenever people move: a player at 0.60 who walks gets named, a look-alike at 0.69 whose movement doesn't match the player's phone doesn't.
- **It confirms or vetoes the shot** (`fuseMotion`): a contradicting phone blocks the shot, or redirects it to the one other candidate whose phone does match.

Motion only decides after a few seconds in which both the person and their phone are clearly moving (a 6 s correlation window). Standing still leaves it out of the decision. The shooter's own turning masks the image above 25 °/s (`PANNING_DEG_PER_S`); the original 10 °/s masked almost all hand-held aiming.

### Latency

Measured on the benchmark (below) for a person scoring 0.77: the first re-identification result arrives about 0.1 s after the person appears, they're named after about 0.2 s and shootable after about 0.35 s (it was about 0.55 s).

- The hold between naming and the first shot is 150 ms for re-identification (`TARGET_LOCK_REID_MS`, was 350 ms); the colour fallback keeps 350 ms.
- Detection runs every 80 ms while someone is unidentified and every 120 ms once everyone is (was 120/180), but never takes more than 70% of the phone's time (`DETECT_MAX_BUSY_SHARE`).
- OSNet runs in a Web Worker, and when every scan has a re-identification embedding the colour features and MobileNet embedding are skipped: identity work went from 13–20 ms to 2–3 ms per detection on the benchmark.
- Between detections, boxes move along their track's velocity, for both the overlay and the shot.

### Range

People further than about 5 m stopped being detected. Two limits were responsible:

- **The detector's input.** EfficientDet-Lite0 sees each frame at 320×320, so a distant person is a few dozen pixels tall. The fix is a **zoom pass**: on every second detection (`GAME_ZOOM_EVERY`), the detector also runs on the central 1/2.5 of the frame at full camera resolution (`ZOOM_FACTOR`), which gives people near the crosshair 2.5× the pixels. Boxes cut off by the crop's edge are dropped, since the full-frame pass sees those people whole.
- **The size gate.** Boxes shorter than 18% of the frame were never identified. Re-identification crops people from the full-resolution frame, so the gate is now 7% of the frame and at least 96 px (`MIN_MATCH_HEIGHT_RATIO`, `MIN_MATCH_HEIGHT_PX`). Scanning still needs 18%.

Benchmark, phone held upright (720×1280), person on a cluttered background slightly off centre. Distances are rough, for a typical phone camera:

| Person height | ~Distance | Box found (before → after) | Identified (before → after) |
| --- | --- | --- | --- |
| 30% of frame | 5 m | 85% → 93% | 84% → 91% |
| 22% | 7 m | 35% → 69% | 29% → 67% |
| 16% | 10 m | 46% → 67% | 0% → 66% |
| 12% | 13 m | 4% → 42% | 0% → 39% |
| 9% | 17 m | 0% → 23% | 0% → 20% |

The percentages are per detection; a track survives about half a second between sightings, so a person seen on every second detection stays named and shootable. A non-player at the same sizes was never named (score around 0.45). The cost is detection rate: from 6.7–9.5 to 5.7–6.1 detections per second on the benchmark, depending on how many people the full-frame pass found. Running the zoom pass on every detection reaches 78% at 12% height but drops to 4.9 per second; every third detection gives 6.6 per second but only 18%.

The zoom pass only covers the middle of the frame, which is where you aim. A far person at the edge of the picture is still missed until you turn towards them.

## How it was measured

The numbers above come from a bench that replays the game's detection and identification loop in headless Chrome, throttled to 4× slower CPU to approximate a phone, on fake camera videos built from Market-1501 photos: a player (Market-1501 person 1, whose other photos form the gallery), a clearly different bystander, and the player's closest look-alike in the dataset (mean score 0.76 against the player). The range videos paste the same photos at fixed sizes into a portrait frame.

Limits to keep in mind:

- Market-1501 photos are small (128×64), so the large sizes are blurry upscales and the far sizes are close to native resolution. Real far-away people look worse than that, so expect real scores to drop with distance where the bench's don't.
- Headless Chrome renders the detector with a software GPU; phones are faster at the models and slower at everything else.
- Motion can't be benchmarked this way. Its effect is covered by unit tests (`test/motion.test.js`, `test/reid-matching.test.js`) and needs real games.

## Known limits

- **Look-alikes.** Someone dressed like a player scores close to them on appearance. Motion is the only signal that separates them, and only while people move.
- **Far people's scores.** Small crops carry less detail, so expect lower and noisier scores at range; if far players are named but rarely shootable, a slightly lower `?reid=` helps more than anything in detection.
- **Frame rate.** The zoom pass costs up to a third of the detection rate on the benchmark. On a slow phone, raising `GAME_ZOOM_EVERY` to 3 trades range for speed.
