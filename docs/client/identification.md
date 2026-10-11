# Player identification

Detection only says "there's a person here". With more than two players, a phone also needs to know *who* that is, to credit the right hit. The client answers that with four pieces:

1. **Signatures**: a compact description of how a person looks in one frame (`identify.js`, plus the re-identification embedding from `reid.js`).
2. **Gallery matching**: compare a signature against every player's scanned gallery (`identify.js`).
3. **The tracker**: follow people across frames so identity is stable and matching doesn't run on every frame (`identify.js`).
4. **Motion confirmation** (optional, off by default): check the person's on-screen movement against what each player's own phone reports, and *confirm* the answer appearance arrived at — never replace it ([`motion/`](#phone-motion-confirmation-motion)).

Everything runs on the phone. Players' galleries come from the server's `roster` message — every phone holds everyone's signatures, which is why the roster is sent as a [delta](../server/protocol.md#the-roster-delta) rather than trimmed: each gallery still reaches each phone, just only once. With `?motion=on`, phones' motion activity arrives the same way, via the server's `motion` relay.

## The signals, in order of strength

Appearance matching uses whichever of these it has, strongest first:

| Signal | Where | Used when | Measured strength |
| --- | --- | --- | --- |
| **Re-identification embedding** (`reid`) | OSNet x0.25 in `reid.js` | Both the live signature and the gallery sample have one. It then **decides alone**: the colour parts are computed but not mixed in. | ~77% of players recognised at a 5% bystander-acceptance rate (Market-1501, 2–4 enrolled players + 20 bystanders) |
| **Colour + MobileNet embedding** | `identify.js` + the embedder from `detector.js` | No `reid` on one side, but both sides have `embed`. The score is a weighted blend of the colour parts and the embedding. | ~34% at the same false-accept rate, for the whole colour + embedding signature |
| **Colour only** | `identify.js` | Neither model loaded. The baseline: upper/lower histograms, grid and shape. | weakest |

Both models are optional. `createReid()` failures and `createEmbedder()` failures are both caught in [`startup.js`](app-flow.md#what-continue-actually-waits-for), which lands `null` in the corresponding `state` slot (the delegate label simply loses its `+ReID` or `+Embed` suffix), so the game degrades to the next row down rather than breaking. A phone where OSNet failed to load still scans and still plays — its galleries just carry no `reid`, and matching falls to the second row.

Being optional is why neither is on the critical path into the lobby. It is also why [enrolment](scanning.md#0-waiting-for-the-models-if-it-comes-to-that) waits for both before it starts: *failing* to load is graceful degradation the player can see and live with, whereas enrolling a gallery while they were still *loading* is silent degradation baked into a cached gallery for the whole round.

## Signatures

`extractSignature(source, box, embedder, timestamp)` returns:

| Field | Length | What it captures | Region of the person box |
| --- | --- | --- | --- |
| `hist` | 64 | Upper-body colour: 12 hues × 4 saturations (48), plus 8 brightness and 8 saturation bins so grey/black/white clothes still count | x 16–84%, y 20–62% |
| `lower` | 64 | Same descriptor for the lower body. A strong guard: a similar shirt isn't enough if the trousers differ. | x 18–82%, y 58–92% |
| `grid` | 192 | 6×8 grid of brightness, saturation and hue (as sin/cos weighted by saturation). A rough colour+shape fingerprint that *does* change with viewing angle. | x 8–92%, y 6–94% |
| `shape` | 2 | Box aspect ratio, and the ratio of its height to its width as fractions of the frame. The only field kept on its **raw** scale rather than L2-normalised — see below | whole box |
| `embed` | 256 | Optional MobileNetV3 embedding, compacted from the model's output and rounded to 4 decimals so galleries stay small | box with a little padding |
| `usable` | bool | Whether the box passed `boxQuality()` — big and whole enough to trust at all. `false` means no path will score it. See [Box range](#box-range) (not sent to the server) | |

A sixth field, `reid` (512 floats), is **not** produced by `extractSignature`. Because inference is asynchronous it is attached by the caller afterwards — and the two callers do it very differently:

- **Scanning** awaits it (`await reid.embed(...)`), but only for the frames behind a gallery sample that survived selection, *after* selection has run. Selection itself never looks at `reid`. See [Scanning → Deferred work](scanning.md#5-deferred-work-and-what-it-saves).
- **The tracker** never awaits it. It takes whatever `reid.latest(track)` already holds and asks for a fresh one for next time.

Colour features are computed by drawing the region onto a tiny canvas (18×24 for histograms, 6×8 for the grid) and reading the pixels, which is cheap.

**`shape` is the one exception to normalisation.** `hist`, `lower`, `grid`, `embed` and `reid` are all L2-normalised, on both the live and the gallery side (`averageVectors`), which costs nothing because they are compared with cosine similarity — it divides by the magnitudes anyway. `shape` is compared as a **log ratio of aspects**, which is scale-*sensitive*, so it is averaged raw (`meanVector`) and an enrolled `shape[0]` is a genuine aspect ratio you can read. Normalising it, as the code used to, divided each aspect by its own vector's magnitude; since the second component is just the aspect times the frame's aspect ratio, that cancelled the aspect out entirely and every enrolled person ended up with the same value — 0.600 in a 4:3 frame — so the correct person scored 0. Fixed; the tuning question it left open is in [Open items](../open-items.md), and the gallery format change is one of the reasons `SCAN_CACHE_VERSION` has been bumped.

`averageSignatures()` averages a list of signatures field by field (including `reid`, re-normalised); scanning uses it to smooth samples. Because scanning attaches `reid` *after* averaging, `scan-reid.js` re-does that one field with the same arithmetic (`averageReidVectors`), so an averaged sample still ends up with the mean of its frames' embeddings.

## Box range

`boxQuality()` decides whether a detector box is worth a signature at all, and the answer is the
advice shown during enrolment ("step a little closer"), checked in that order: too small
(`too-far`), a bad aspect ratio (`partial-body`), then touching the frame edge while still small
(`edge-clipped`). `extractSignature()` publishes the verdict as `usable`, and an unusable box
produces **no ranking on any path** — `bestAngleScore()` returns `null`, so it is never identified
at any score, by any signal.

For live matching the limits are `MIN_MATCH_HEIGHT_RATIO`, **0.065 of frame height**, and
`MIN_BOX_WIDTH_RATIO`, **0.018 of frame width**. They are the range limit, and they come from
camera geometry: a typical phone sees about 65° across the long side, so a 1.75 m person at 20 m is
roughly 7% of frame height and about 0.02 of the width when the phone is held sideways.

**Which of the two actually binds depends on the box's shape, and for anyone standing up it is the
width.** At an aspect of 2.5 in a 16:9 frame a box's width ratio is its height ratio ÷ 4.44, so
0.018 of a 1280-wide frame — 23 px — is reached at **0.080** of frame height, while the 0.065
height floor is still below it. The usable reach for a standing person is therefore the width
floor's 0.080, not 0.065: 2.25× the old gate's linear range rather than 2.8×. The height floor
binds only for squatter boxes — crouching, or half a body in frame — where height runs out first.

These were **0.18 and 0.035** until the range change, which at 720p is a 130 px box: a 1.7 m person
at roughly 10–12 m. A player past that was never identified at all.

| `usable` | When | What may score it |
| --- | --- | --- |
| `true` | passed `boxQuality()` | everything: `reid`, the MobileNet blend, or colours alone, whichever the room has |
| `false` | too small, a bad aspect ratio, or clipped by the frame edge while still small | nothing, and no OSNet inference is spent on it either |

There is no signal-specific relaxation and no penalty band. One gate, one answer, and whatever
passes it is scored by whichever signal the room is on — which is exactly why the **closed-set
score floor** matters now. Closed-set mode assumes everyone in frame is a player and waives the
colour path's corroborating gates (the per-part minimums and the margin, which exist to prop up a
weak signal in a room that might contain bystanders). It used to waive the score floor with them,
accepting the best of a field of non-matches at *any* score — a track was observed being named at
**0.0**. With a 0.18 gate a distant box never reached a colour ranking, so that was unreachable
from range; at 0.065 it is directly reachable, and on a phone where OSNet failed to load a tiny far
box would be named with no threshold whatsoever. `decideRankings()` now keeps `MATCH_THRESHOLD` on
the colour path in closed set, and all of the thresholds on the re-identification path.

`Tracker.update()` does not ask `reid.js` for an embedding on an unusable box. It used to request
one before matching and the result was discarded at the `usable` gate, so every too-small box in
frame bought a full 128 × 256 inference, plus a `getImageData(128, 256)` readback on the main
thread, on every check. A coasting track is skipped for the same reason: with no box this cycle
`track.box` is the last smoothed observation, stale by one or more cycles, so embedding it buys a
readback of wherever the person *was* and feeds it to the 3 s median as if it were an observation
of where they are.

## The re-identification embedding (`reid.js`)

`reid.js` wraps **OSNet x0.25** (Zhou et al., *Omni-Scale Feature Learning for Person Re-Identification*), trained on MSMT17 by the Torchreid authors — MIT licence — and exported to ONNX as `frontend/public/models/osnet_x0_25_msmt17.onnx` (0.9 MB). Unlike the colour features and the generic MobileNet embedding, it was trained for exactly this job: deciding whether two crops of a person are the same person, across cameras, angles and lighting.

It runs in **ONNX Runtime Web** on WebAssembly, served from `node_modules/onnxruntime-web/dist/` at `/vendor/ort/` by nginx — not through MediaPipe. Threading needs cross-origin isolation, which the game doesn't have, so it runs single-threaded unless `crossOriginIsolated` is true; the model is small enough that this is fine.

### Pre-processing

Each person box is cropped and resized to the model's **128×256** input, converted to ImageNet-normalised CHW floats (mean `0.485, 0.456, 0.406`, std `0.229, 0.224, 0.225`). The output is a 512-dimensional vector, L2-normalised and rounded to 4 decimals so a 24-sample gallery still fits comfortably in a `join` or `scan` message.

### The asynchronous API

Inference can't be done inline in the render loop, so the module is request/collect:

```js
const reid = await createReid();
reid.request(track, video, track.box); // snapshot the crop now, embed in the background
reid.latest(track, maxAgeMs);          // most recent embedding for that key, or null (default 800 ms)
await reid.embed(source, box);         // one-off, awaited; used while scanning
```

- `request()` grabs the pixels immediately and queues the inference. One inference runs at a time; a second request for the same key while one is pending is dropped rather than queued, so the model never falls behind the camera.
- Results are stored in a `WeakMap` keyed by the object you pass (the tracker passes the track), so entries disappear with the track.
- `latest()` returns `null` for an embedding older than `maxAgeMs` (800 ms by default), which is what makes the tracker fall back to "not yet identifiable" rather than matching against a stale crop.

### How much of it runs, and where

The model is the most expensive inference in the app, so both callers limit how often it runs — in opposite ways:

| | Scanning | Gameplay |
| --- | --- | --- |
| Call | `embed()`, **awaited** | `request()` / `latest()`, never awaited |
| How often | Once per frame backing a chosen gallery sample — roughly **30 inferences per scan**, after selection has picked the samples | At most one in flight at a time; requested on each due identity check per track (its first 6 checks, then every 250 ms) |
| If it isn't ready | Not applicable — the scan waits | The check is **skipped** and the track stays unnamed |
| If it fails | The whole scan fails with *"Could not process the rotation video"* | Logged and ignored; the track simply has no recent embedding |

[Detection → Which model runs when](detection.md#which-model-runs-when) has the same comparison for all four on-device models.

### Why it overrides rather than blends

When both sides of a comparison have a `reid` vector, `similarityParts()` sets the match score to the cosine similarity of the two embeddings alone. Blending the colour parts in was measured to make it *worse*, so the colour similarities are still computed but only reported (for the debug overlay) and not weighted into the score. `hasReid` on a match result says which mode produced it.

## Comparing a signature to one player

`bestAngleScore(signature, gallery)` compares the signature with every sample in the player's gallery. For each sample it computes cosine similarities for `hist` (*upper*), `lower`, `grid`, `embed` and `reid`, and a log-ratio similarity for `shape`. How those become one score depends on what's available:

| Available on both sides | Score |
| --- | --- |
| `reid` | the `reid` cosine similarity, on its own |
| `embed` (but no `reid`) | 0.30 upper + 0.18 lower + 0.16 grid + 0.06 shape + 0.30 embed |
| neither | 0.42 upper + 0.24 lower + 0.24 grid + 0.10 shape |

The best-matching sample wins: this is what makes matching work from any side, since the gallery holds front, side and back views. To avoid trusting a single lucky sample, the final score blends in the other samples that score within 0.1 of the best (up to 3 in total): 75% best + 25% their average, plus 0.012 per supporting sample.

## Matching against the room

`matchGallery(signature, players, excludeId, options)` scores every player, ranks them, and records each one's margin over its closest rival. The acceptance rules differ per mode.

### With a re-identification embedding

Only two checks apply, because the score is a single well-calibrated similarity:

| Check | Threshold | Rejection reason |
| --- | --- | --- |
| Overall score | ≥ 0.65 by default (`?reid=` to tune); inside the tracker, the median of the last 3 s of checks (`REID_HISTORY_MS`) | `score` |
| Lead over runner-up | ≥ 0.03 (`REID_MATCH_MARGIN`) | `margin` |

The threshold was chosen on Market-1501 in simulated 2–4 player games, per single check:

| Threshold | Players recognised | Bystanders accepted | Wrong player |
| --- | --- | --- | --- |
| 0.70 | 87% | 10.8% | 0.3–0.5% |
| 0.72 | 83% | 7.6% | 0.3–0.5% |
| 0.74 | 77% | 4.9% | 0.3–0.5% |
| 0.76 | 71% | 3.1% | 0.3–0.5% |

Those are per-check numbers; the tracker needs several agreeing checks before it names a track, so the per-person bystander rate is lower again. The margin check is what halves wrong-player assignments.

### Without one (colour, with or without `embed`)

In **open-set** mode the best player is accepted only if all of these hold. Otherwise the person stays unknown:

| Check | Threshold | Rejection reason |
| --- | --- | --- |
| Overall score | ≥ 0.54 | `score` |
| Upper-body similarity | ≥ 0.50 | `upper` |
| Lower-body similarity | ≥ 0.38 | `lower` |
| Grid similarity | ≥ 0.40 | `grid` |
| Shape similarity | ≥ 0.36 | `shape` |
| Lead over runner-up | ≥ 0.06 | `margin` |

These floors apply to the `embed` blend as well as to colour alone — `rejectionReason()` skips them only when `hasReid`. That matters for the `shape` row: until the normalisation fix it could never be met, so **both** model-free paths rejected every open-set candidate that got that far, and `EVIDENCE_MIN_PART` (which applies the same floor to each part) stopped the tracker's evidence accumulator from ever filling. The gate is reachable again and the 0.36 is [unchanged on purpose](../development/configuration.md#identification).

If the best match is the local player (`excludeId`), the result is rejected with reason `self`.

### Closed-set mode

The game runs matching in **closed-set** mode: the local player is included as a candidate (for the self-match guard) and the ranking is returned even when nothing clears the bar. What happens to a sub-threshold best match differs by signal:

- **Colour only:** closed set waives the *corroborating* gates — the per-part minimums and the margin, which exist to prop up a weak signal in a room that might contain bystanders — and keeps the **score floor** (`MATCH_THRESHOLD`, 0.54). It used to waive the floor too and accept the best match at *any* score, which is exactly what labelled bystanders as players: a track was observed being named at **0.0**. See [Box range](#box-range) for why the range change made that reachable rather than theoretical.
- **With `reid`:** every threshold is kept (`accepted` is only true when nothing was rejected), because the scores are reliable enough to say "none of them". A bystander in frame stays "Person".

That second guarantee used to hold only while **one** person was on screen: with two or more visible tracks, [closed-set assignment](#5-closed-set-assignment) reassigned every track from the raw rankings without consulting `accepted` or `reason` at all, so a bystander matching nobody still got a name. It now holds whatever the room contains — see that section for what the resolver may assign.

The "is this good enough to shoot?" decision still belongs to the [targeting rules](app-flow.md#shooting).

### One scale for the room

A colour/`embed` cosine and an OSNet cosine are not the same quantity. Colour runs 0.95+ for the same person and 0.85–0.96 for a *different* person in similar clothes; OSNet runs 0.70–0.85 for the correct person. So the two can never be sorted against each other, and `roomScoresOnReid()` decides **per room**, not per pair: re-identification scores a room only when *every* enrolled player's gallery carries a `reid` vector, and one reid-less gallery puts everyone on the blended path.

A gallery is all-or-nothing for `reid` (`screens/scan.js` enrols one or none), so the mix is always *across* players — a phone whose OSNet failed or timed out, or a restored cache from before it existed. Deciding per pair meant that one player was read on the higher scale and became an attractor that outscored every correct re-identification match in the room, and because the winning match then had `hasReid: false` the colour accept path, the colour shot floor (0.48) and the colour-only initial lock (0.66) all applied to a name that was wrong.

Dropping the whole room to the blend is a real loss of accuracy for the players who *do* have embeddings. It is still the better trade: the blend is a weaker signal applied consistently, where the mix was a stronger signal applied incomparably.

### The self-match guard

The game adds the local player's own gallery to the candidate list under the label "Person". If a body looks most like *you* (a reflection, or your own webcam in debug mode), it's claimed by "self", the track is marked `selfRejected` and it can't be credited to someone else.

## The tracker

`Tracker.update(boxes, video, players, selfId, now, options)` is called after each detection. It returns the list of tracks, each with a box, a velocity and an identity (`playerId`, `name`, `score`, the per-part similarities, and `hasReid`/`reid` when the re-identification model decided).

`options` are `{ includeRejected, embedder, reid, identifyOnce, closedSet }`. The game passes the embedder, the `reid` handle, `closedSet: true`, and `includeRejected` only in debug mode.

### 1. Associating boxes with tracks

Each existing track predicts where it is now by projecting its last *measured* centre along its velocity (not its drawn box, which is smoothed and so always a little behind the measurements it is predicting). Every (track, box) pair is scored as 0.5 × IoU + 0.35 × centre closeness + 0.15 × size similarity. Pairs scoring at least 0.3 are matched greedily, best first.

Unmatched boxes start new tracks. Tracks not seen for 900 ms are dropped; in between they coast on a damped velocity, and `missedFrames` says for how many detections.

#### Movement, and why it is written in seconds

Three filters run on every matched track, and all three are time constants (`1 - exp(-dt/tau)`) rather than per-detection blend factors, because the detection interval is neither fixed nor the same on every phone: 50 ms while something is being searched for, 100 ms once everything is found and named, longer on a slow device, and longer again across a missed detection.

| | | |
|---|---|---|
| `BOX_SMOOTHING_TAU_MS` | 40 ms | the drawn box, which `game.js` also shoots |
| `VELOCITY_SMOOTHING_TAU_MS` | 180 ms | `track.vx/vy`, measured from raw detection centres |
| `COAST_VELOCITY_TAU_MS` | 600 ms | how fast an unseen track's velocity fades |

Position and velocity are filtered **independently**, and velocity from the raw centres rather than from the smoothed box. They used to be one number, which meant any reduction in display lag was paid for in association quality and in aim.

A time constant is not quite free of the detection rate, and it is worth knowing which way each one bends when the rate goes up:

- **Position gets laggier.** A one-pole filter sampled every `dt` settles `v · dt · (1-a)/a` behind a target, which grows toward `v · tau` as `dt` shrinks. At the old 120 ms interval `tau = 60 ms` trailed 7.5 px at 400 px/s; at 50 ms the same tau trails 15.4 px. `tau = 40 ms` restores the tuned figure (8.0 px at 50 ms, 3.6 px at 100 ms) for less box noise than the old operating point had.
- **Velocity is flat.** The noise of a filtered difference quotient is `(a/dt) · sigma · sqrt(2/(2-a))`, and `a/dt → 1/tau` as `dt` shrinks: the extra differencing noise is paid for by the extra averaging. 120 ms → 50 ms costs 11%, against a 19% asymptote. Unchanged.
- **Coasting was rate-coupled, and that was a real regression.** It used to be a flat ×0.82 per update — a 419 ms half-life at the 120 ms interval it was tuned at, but a 175 ms half-life at the 50 ms interval a coasting track now forces (`missedFrames > 0` picks the fast tier). A person stepping behind a pillar for 300 ms came back with 30% of their velocity instead of 61%, so the prediction under-shot and the track was likelier to be dropped and re-created as a stranger. `600 ms` is `-120 / ln(0.82)` rounded, so it means at 50 ms what 0.82 meant at 120 ms, and the same thing at every other interval.

Two bounds stay in wall-clock units on purpose. `VELOCITY_MAX_GAP_MS` (400 ms) is how long a gap may be before the straight line across it stops being a velocity — a bound on how fast a person can reverse, which no detection rate changes. `MIN_FRAME_DT_S` (16 ms) is one video frame, and exists only for the detection the shot path can force a millisecond after a scheduled one.

The association threshold stays at 0.3. A faster rate raises every *correct* pair's score, since boxes move less between frames, but that is not a reason to tighten it: a wrong pair's score is set by how close the two people are, not by the interval, so the margin improved rather than narrowed. And the threshold is not what decides a crossing — pairs are taken best-first, and when both candidates clear 0.3 comfortably (two people close enough to confuse are) the ordering decides and the gate is never consulted. What resolves a crossing is the velocity prediction; `test/track-motion.test.js` shows two people walking through each other staying on their own tracks, and swapping when the prediction is taken away. Raising the gate leaves that outcome untouched and costs a correct re-association after an occlusion.

### 2. Deciding when to re-identify

Matching only runs on a track that was seen this frame and:

- has no identity yet (such a track is due on every detection), **or**
- hasn't been checked for `RECHECK_MS` (100 ms).

Between checks, identity simply rides along with the track.

### 3. Waiting for a re-identification embedding

When a `reid` handle is passed, each due check:

1. takes the track's most recent embedding (`reid.latest(track)`);
2. asks for a fresh one for the next check (`reid.request(track, video, track.box)`);
3. **skips the check entirely if there is no recent embedding.**

That last step matters: while the model is still warming up on a new track, the track is left unidentified rather than being named from colours alone. Identifying from colours in closed-set mode is what used to put a player's name on a bystander.

### 4. Evidence and hysteresis

Each check adds **evidence** for every player it scored, and old evidence decays (×0.82 per check). The accepted winner adds 1.25; plausible runners-up add `0.45 +` however far the score is above the evidence floor; weak ones add nothing. A player becomes the evidence winner once they have at least 0.58 and lead the next player by 0.12.

A check rejected for `margin` adds nothing at all, to either side. And "every player it scored" is what makes the 0.12 lead mean anything: only the single best candidate used to be recorded, so against a *persistent* narrow leader the runner-up's bucket stayed empty, the lead was the leader's whole bucket, and the margin was passed trivially on every check — it only ever bit on rapid alternation, never on the stable near-tie it reads as guarding. Between them those two were how a tie got named anyway, two checks later, by the one route that had not been told it was a tie (`evidenceWinner` is consulted *before* `softLabelMatch`).

The floors for "plausible" depend on the signal:

| | Minimum score to count as evidence | Minimum score for a soft label |
| --- | --- | --- |
| With `reid` | threshold (`reidEvidenceMinScore()`) | threshold (`reidSoftLabelScore()`) |
| Colour | 0.42 (`EVIDENCE_MIN_SCORE`), and each part ≥ 0.24 | 0.48 (`SOFT_LABEL_SCORE`), and each part ≥ 0.24 |

A *soft label* is a rejected match that is still good enough to be the track's candidate for the hysteresis below. Matches rejected for `margin` are never soft-labelled: an ambiguous frame should not nudge the identity either way.

The identity then changes only through hysteresis:

| Situation | Needed to (re)assign |
| --- | --- |
| New track, very confident match (score ≥ threshold + 0.08, at least 0.80, with `reid`; ≥ 0.66 without) | 1 check |
| New track, otherwise | 2 agreeing checks in a row |
| Track already identified as someone else | 4 agreeing checks in a row |
| Check finds no candidate | Identity is **kept**. A known track only loses its identity when it disappears, loses a conflict, or another player wins the switch. |

This stops a single blurry or side-on frame from flipping who you'd be credited with shooting.

#### Revocation: when a name is dropped rather than changed

Separately from the switch above, a named track can have its name *revoked* — nobody else won it, this just isn't that player any more (they walked off and a bystander stepped into the same box). `revokedByReid()` needs two things to agree, because the raw score and the median answer different questions:

- the **raw** score for the track's own player is below `REID_REVOKE_SCORE` (0.6) on `REID_REVOKE_CHECKS` (3) consecutive checks — the fast trigger, and nothing is revoked without it;
- **and** the median has stopped clearing the accept floor — the authority, since the median is what granted the name and what [grants the shot](app-flow.md#shooting).

Revocation used to read the raw score alone, which overrode the median in exactly the case the median exists for. Three consecutive checks is 750–900 ms at `RECHECK_MS`: an ordinary side view or motion-blur burst, not a substitution. A player holding 0.84–0.87 with a three-check burst at 0.55 lost their name, their evidence **and** the whole history the median was built from, then spent ~600 ms unidentified while it refilled from a single sample.

Tying them together costs one check of latency on a genuine substitution (a 0.95 player replaced by a 0.30 stranger loses the name on the fourth bad check rather than the third). That check is also the first on which the median falls under the shot floor, so the substitute was never shootable any earlier either: the extra latency is in the displayed name only, and the name and the shot are now lost together instead of one to two checks apart.

When a name does go, it goes completely: `clearIdentity()` resets the evidence buckets, the re-identification history and both miss counters along with the identity. Leaving those behind meant a track cleared mid-dip was revoked again by the *first* low check after being re-named, and a track cleared by duplicate resolution kept a full bucket for the player it had just lost — which the evidence winner then re-proposed, flip-flopping the track every two checks and restarting its shot lock each time.

### 5. Closed-set assignment

In closed-set mode with two or more visible tracks, `resolveClosedSetIdentities()` solves the assignment for all visible tracks together: it ranks every (track, player) pair by score, with small bonuses for margin, keeping the current identity, accumulated evidence and supporting angles, and assigns greedily so each player gets at most one track.

What it may assign is the whole question, and it is bounded by three rules — without them a greedy pass over the raw rankings silently overrode every accept threshold, both streak counters and the latch, whenever a second person was on screen:

| Rule | Why |
| --- | --- |
| Only candidates that clear the accept floors are considered — the threshold plus any [range penalty](#box-range) with `reid`, or 0.48 and each part ≥ 0.24 without | The resolver chooses *among* credible candidates; it does not manufacture one. A bystander whose best score is 0.07 offers nothing to assign |
| A track whose top two candidates are inside the accept margin offers nothing | That is a tie, and which name lands on which person would be decided by the sort order. Waiting is the documented behaviour |
| A track already holding a name offers only that name | Changing an identity is the switch hysteresis' job (4 agreeing checks). A greedy pass that reassigns on one check is how a look-alike takes a name |

A track the resolver does not assign **keeps whatever the per-track logic left it**, latched name included — the resolver used to clear it, which overrode the "check finds no candidate → identity is kept" rule in the table above for no better reason than that someone else was in frame. The one case that still clears is the one the resolver exists for: the track holds a player this resolution has just given to a better-supported track.

The bound on the third rule is worth being precise about: it governs *when* a name may change, not whether a track may ever be reassigned. A track that has lost its name is a free agent on the next check, and giving it its next-best unclaimed player is exactly what closed-set assignment is for.

### 6. Duplicate resolution

Finally, if two tracks still carry the same player, the one seen this frame (then the higher-scoring one) keeps it and the others are cleared.

## Swapping in a better model

`extractSignature()` and `matchGallery()` are the only boundary the rest of the code depends on. `reid` was added exactly this way — as another signature field, without touching the tracker, scanning or game code — and a future model can be too. Remember to:

- add the field to `GALLERY_FIELDS` in `backend/sanitize.py` (see [Protocol → Gallery format](../server/protocol.md#gallery-format));
- decide how it combines with the existing score in `similarityParts()` (`reid` overrides rather than blends, because blending measured worse);
- give it its own thresholds if its scores aren't on the same scale as the colour score — `rejectionReason()`, `evidenceWeight()` and `softLabelMatch()` all branch on `hasReid` for this reason;
- bump `SCAN_CACHE_VERSION` in `scan-cache.js` so stale cached scans are ignored (see [Scanning → Why the version exists](scanning.md#why-the-version-exists));
- check whether [sample selection](scanning.md#4-sample-selection) should use it. `signatureSimilarity()` in `scan.js` deliberately uses the colour fields only, which is both why a view-invariant field like `reid` must stay out of it and why such a field can be computed after selection instead of during it;
- check the [gallery size](../server/protocol.md#gallery-format) still fits under `MAX_BODY_BYTES`.

## Tuning

All thresholds and weights are module constants in `identify.js` and `reid.js`. See [Configuration → Identification](../development/configuration.md#identification). Use [debug mode](../development/debug-mode.md) to see live scores and rejection reasons while tuning.

## Phone-motion confirmation (`motion/`)

**Off by default. `?motion=on` or `?motion=strict` turns it on, and it has never been validated
against a real accelerometer.** Treat every number below as the output of a simulation.

Appearance can't tell apart two people in similar clothes, and it can put a player's name on a
bystander who looks like them. Motion adds a signal with nothing to do with appearance: **every
phone knows how much it is being moved, and the camera can see how much each person on screen is
moving.** They should rise and fall together for the right pairing and be unrelated for a wrong one.

### What each phone shares (`motion/sensor.js`)

`MotionSensor` condenses `devicemotion` into one number per 100 ms bin:

- **activity**: the RMS of linear acceleration (gravity removed, with a low-pass fallback on
  devices that only report `accelerationIncludingGravity`), in m/s². Walking shows clearly;
  holding the phone to aim barely does.
- **ego**: `1` if the phone's own rotation rate exceeded `PANNING_DEG_PER_S` anywhere in the bin.
  This is the *shooter's* panning flag — while you swing the camera to follow someone, image motion
  says nothing about how they are moving, so those bins are masked out of the correlation.

`PANNING_DEG_PER_S` is **25**. Earlier versions of this page and of the configuration table said
10; the code always said 25. 10 is wrong in the direction that matters — an ordinary hand-held
phone's aiming corrections exceed 10 °/s, so most bins get masked and motion almost never has
enough window to say anything.

`requestPermission()` must run inside a user gesture on iOS; `app.js` calls `startMotion(send)`
from the join-form submit and again on FIRE (after `fire()`, since that listener is the measured
input path). Refused permission breaks nothing: checks return `unknown` and appearance decides.

Samples are flushed every 500 ms as `{type: 'motion', s: [[t, v], ...]}`; the server sanitises
them (`clean_motion_samples`, bounded by `MAX_MOTION_ACTIVITY` as well as finite) and relays each
phone's to everyone else in the room, keeping no history.

### The check (`motionCheck`)

`motionCheck({visual, remote, ego, now, ...options})` resamples both series onto a 100 ms grid over
the last 6 s, then searches clock offsets from −400 to +400 ms for the best Pearson correlation,
skipping bins where either series has no data or the shooter was panning. `visualActivity()` turns
a track's box history into the comparable quantity: how fast the box centre moves in **box heights
per second**, so it doesn't depend on distance. Boxes under 8 px high are skipped — their centre is
detector jitter, and at `h = 0` the division produced `Infinity` and then `NaN`. (The old note here
claimed `detectTrackedPeople` filtered boxes to `h > 8`; that filter is on the **pose** boxes only.)

Returns `consistent`, `inconsistent` or `unknown`, and `unknown` is much the most common answer in
practice: two people standing still produce no usable correlation at all.

### What it is allowed to do (`target.js`)

**Motion is additive only, in every mode.** It may confirm — `targetConfirmedBy()` returns
`'moves'`, which is how the overlay shows *"Name (moves)"* — and it may do nothing else. The id
`targetPlayerId()` returns with motion on is identical to the id it returns with motion off, for
every possible correlation.

This is a deliberate reduction from the previous design, which the project's audit recorded as able
to "veto or silently retarget a correct identification". Both are gone:

- **Retargeting is gone in both modes.** Nothing in `motion/` can name a player;
  `motionConfirmation()` only answers about the id handed to it. This was the half that could hurt
  a third party who did nothing.
- **Motion-only naming is gone** — a shot can no longer land on an identity that came from
  correlation alone.
- **Motion cannot raise an appearance threshold either.** A perfectly matching phone does not
  shorten the target lock or excuse a low score, because that would let an unvalidated correlation
  create a shot appearance refused.

- **The veto is gone.** `?motion=strict` used to withhold a target motion had not confirmed,
  bounded to that one safe direction, and the argument for keeping it was that withholding is the
  entire content of the flag. The rule it broke is simpler than the argument: motion contributes
  to the decision, it does not replace it, and withholding an identity appearance has accepted
  *is* replacing it. It was also unplayable — correlation needs variance, so two people standing
  still reads `unknown` (by far the most common answer), and strict made everybody in a stand-off
  unshootable; declining one iOS sensor prompt had the same effect for a whole round.

`?motion=strict` is now an **alias for `?motion=on`** rather than an error, so a typed-out URL
degrades to the working mode instead of silently turning motion off. `REQUIRE_MOTION` is gone.
`target-motion-strict.test.js` asserts the property that regresses if the veto comes back: for
every correlation the real maths can produce — consistent, inconsistent, unknown, and nothing
shared at all — the id is the id appearance gave.

What motion could still usefully contribute to is **detection**: an enrolled, alive player whose
phone reports movement with no live track named as them is evidence that a known person is in the
room and has not been found, which is a reason to run the fast detection tier. That is not built —
it needs the identified-id set threaded into `detectTier()` and a refractory so a pocketed phone
cannot pin the fast tier open — and it would produce no box, reach no threshold and name nobody.

### Why there is no provider seam

This used to be one of two interchangeable six-method "identity providers" behind `identity.js`.
That indirection earned its keep only while motion could answer *differently* from appearance —
which was the defect. Once motion may only agree, there is no second answer for a second provider
to give, so motion consults from `target.js` in four lines and `targetPlayerId()` keeps its
signature. `isStableTarget()` is untouched.

### Per-room state and teardown

`motion/index.js` holds everything privately: this phone's sensor, a player id → activity map, and
`WeakMap`s from track to box history and to the last checks, all trimmed to 12 s. None of it is on
the shared `state` object or written onto track objects. `leaveRoom()` calls `stopMotion()`, which
clears the flush interval, stops the sensor and forgets every relayed player id. The function
existed before the subsystem was deleted; **nothing called it**, which is what made it a leak for
the life of the page — a phone back on the join screen kept waking its accelerometer.

Box history is recorded at most once per detection (keyed on `track.lastSeen`, which the tracker
advances only on a real association, never while a track coasts), so the frame loop asking several
times per frame does not fill it at frame cadence.

### What is still unknown

Every accuracy figure this subsystem has ever had came from a synthetic random walk
(`test/motion.test.js`): a scripted stand/walk pattern turned into a clean 10 Hz series and a box
sliding across a frame with uniform jitter. Those tests are worth keeping — they are deterministic
and statistical over 30 seeds, so they pin the maths against a fixed noise model — but they are not
evidence about a real room. The simulation cannot produce a phone in a pocket or a swinging hand,
clock drift beyond the ±400 ms searched, a backgrounded tab throttling its sensor, two players
walking in step, or a bystander who paces the room like a player. Until those figures come from
real hardware, `?motion=on` is an instrument for gathering them and nothing more.
