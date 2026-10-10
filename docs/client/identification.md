# Player identification

Detection only says "there's a person here". With more than two players, a phone also needs to know *who* that is, to credit the right hit. `public/identify.js` answers that with three pieces:

1. **Signatures**: a compact description of how a person looks in one frame.
2. **Gallery matching**: compare a signature against every player's scanned gallery.
3. **The tracker**: follow people across frames so identity is stable and matching doesn't run on every frame.

Everything runs on the phone. Players' galleries come from the server's `roster` message.

## Signatures

`extractSignature(source, box, embedder, timestamp)` returns:

| Field | Length | What it captures | Region of the person box |
| --- | --- | --- | --- |
| `hist` | 64 | Upper-body colour: 12 hues × 4 saturations (48), plus 8 brightness and 8 saturation bins so grey/black/white clothes still count | x 16–84%, y 20–62% |
| `lower` | 64 | Same descriptor for the lower body. A strong guard: a similar shirt isn't enough if the trousers differ. | x 18–82%, y 58–92% |
| `grid` | 192 | 6×8 grid of brightness, saturation and hue (as sin/cos weighted by saturation). A rough colour+shape fingerprint that *does* change with viewing angle. | x 8–92%, y 6–94% |
| `shape` | 2 | Box aspect ratio, and its height/width relative to the frame | whole box |
| `embed` | 256 | Optional MobileNetV3 embedding, compacted from the model's output and rounded to 4 decimals so galleries stay small | box with a little padding |
| `usable` | bool | Whether the box is big and whole enough to trust (not sent to the server) | |

Colour features are computed by drawing the region onto a tiny canvas (18×24 for histograms, 6×8 for the grid) and reading the pixels, which is cheap. All vectors are L2-normalised.

`averageSignatures()` averages a list of signatures field by field; scanning uses it to smooth samples.

## Comparing a signature to one player

`bestAngleScore(signature, gallery)` compares the signature with every sample in the player's gallery. For each sample it computes cosine similarities for `hist` (*upper*), `lower`, `grid` and `embed`, and a log-ratio similarity for `shape`, then a weighted score:

| Part | Weight without embedding | Weight with embedding |
| --- | --- | --- |
| upper | 0.42 | 0.30 |
| lower | 0.24 | 0.18 |
| grid | 0.24 | 0.16 |
| shape | 0.10 | 0.06 |
| embed | — | 0.30 |

The embedding weights are used only when both sides have an embedding.

The best-matching sample wins: this is what makes matching work from any side, since the gallery holds front, side and back views. To avoid trusting a single lucky sample, the final score blends in the other samples that score within 0.1 of the best (up to 3 in total): 75% best + 25% their average, plus 0.012 per supporting sample.

## Matching against the room

`matchGallery(signature, players, excludeId, options)` scores every player, ranks them, and records each one's margin over its closest rival.

In **open-set** mode (the default), the best player is accepted only if all of these hold. Otherwise the person stays unknown:

| Check | Threshold | Rejection reason |
| --- | --- | --- |
| Overall score | ≥ 0.54 | `score` |
| Upper-body similarity | ≥ 0.50 | `upper` |
| Lower-body similarity | ≥ 0.38 | `lower` |
| Grid similarity | ≥ 0.40 | `grid` |
| Shape similarity | ≥ 0.36 | `shape` |
| Lead over runner-up | ≥ 0.06 | `margin` |

If the best match is the local player (`excludeId`), the result is rejected with reason `self`.

In **closed-set** mode, which the game uses, the local player is included as a candidate and the best non-self player is always returned. Closed-set mode assumes every visible person is one of the room's players, and leaves the "is this good enough to shoot?" decision to the [targeting rules](app-flow.md#shooting).

### The self-match guard

The game adds the local player's own gallery to the candidate list under the label "Person". If a body looks most like *you* (a reflection, or your own webcam in debug mode), it's claimed by "self" and can't be credited to someone else.

## The tracker

`Tracker.update(boxes, video, players, selfId, now, options)` is called after each detection. It returns the list of tracks, each with a box, a velocity and an identity (`playerId`, `name`, `score` and the per-part similarities).

### 1. Associating boxes with tracks

Each existing track predicts where it is now from its velocity. Every (track, box) pair is scored as 0.5 × IoU + 0.35 × centre closeness + 0.15 × size similarity. Pairs scoring at least 0.3 are matched greedily, best first. A matched track's box is smoothed toward the new box (68% new), and its velocity updated.

Unmatched boxes start new tracks. Tracks not seen for 900 ms are dropped.

### 2. Deciding when to re-identify

Matching only runs on a track that was seen this frame and:

- has no identity yet, **or**
- is in its first 6 checks (to identify new people fast), **or**
- hasn't been checked for 250 ms.

Between checks, identity simply rides along with the track.

### 3. Evidence and hysteresis

Each check adds **evidence** for the matched player, and old evidence decays (×0.82 per check). Accepted matches add 1.25; plausible-but-rejected ones add less; weak ones add nothing. A player becomes the evidence winner once they have at least 0.58 and lead the next player by 0.12.

The identity then changes only through hysteresis:

| Situation | Needed to (re)assign |
| --- | --- |
| New track, very confident match (score ≥ 0.66) | 1 check |
| New track, otherwise | 2 agreeing checks in a row |
| Track already identified as someone else | 4 agreeing checks in a row |
| Check finds no candidate | Identity is **kept**. A known track only loses its identity when it disappears, loses a conflict, or another player wins the switch. |

This stops a single blurry or side-on frame from flipping who you'd be credited with shooting.

### 4. Closed-set assignment

In closed-set mode with two or more visible tracks, `resolveClosedSetIdentities()` solves the assignment for all visible tracks together: it ranks every (track, player) pair by score, with small bonuses for margin, keeping the current identity, accumulated evidence and supporting angles, and assigns greedily so each player gets at most one track. Visible tracks left without a player become unknown.

### 5. Duplicate resolution

Finally, if two tracks still carry the same player, the one seen this frame (then the higher-scoring one) keeps it and the others are cleared.

## Swapping in a better model

`extractSignature()` and `matchGallery()` are the only boundary the rest of the code depends on. A stronger person re-identification model can be added as another signature field (as `embed` was) without touching the tracker, scanning or game code. Remember to:

- add the field to `GALLERY_FIELDS` in **both** server implementations (see [Protocol → Gallery format](../server/protocol.md#gallery-format));
- bump `SCAN_CACHE_VERSION` in `app.js` so stale cached scans are ignored.

## Tuning

All thresholds and weights are module constants in `identify.js`. See [Configuration → Identification](../development/configuration.md#identification). Use [debug mode](../development/debug-mode.md) to see live scores and rejection reasons while tuning.
