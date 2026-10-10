# `luxkaiwalker/prune-repo`

**Owner: LuxKaiwalker.** A working branch off `luxkaiwalker-dev`, not a deploy target.

## What this branch is

An audit and prune. The repository had grown a test suite larger than the application it tests,
an archive directory of code already removed from the build, a synthetic measurement harness
nobody runs, and seven documentation files that recorded how one session went rather than what it
concluded. This branch deletes those.

It changes no application code. `frontend/public/` and `backend/` are untouched here.

Nothing lands on `dev` until both suites pass together:

```bash
docker compose run --rm tests          # JS
docker compose run --rm backend-tests  # Python
```

## What is still open

<<<<<<< HEAD
Project-level decisions and risks live in [`docs/open-items.md`](docs/open-items.md) - the CI test
gate, the `MIN_SHAPE_SCORE` / `EVIDENCE_MIN_PART` recalibration, whether MobileNet's 4 MB stays,
and the measurements nobody has taken on a real phone. That file is the one to read and the one to
edit when an item is resolved.
=======
## What merges here

| Branch | Status | What it does |
| --- | --- | --- |
| `luxkaiwalker/tracking-smoothing` | **merged** | Position and velocity now have separate exponential time constants instead of one shared per-detection blend factor. Trailing 22.6 px → 7.5 px *and* velocity noise 18 → 12 px/s; the old coupling meant you could only trade one for the other. Interval-independent, which matters because the detection interval isn't fixed |
| `luxkaiwalker/motion-isolation` | **merged** | Motion is now behind one seam, `identity.js`, which installs a single provider at load. `screens/game.js`, `net.js`, `state.js` and `app.js` contain zero occurrences of the word "motion" |
| `luxkaiwalker/shape-normalisation` | **merged** | LuxKaiwalker branch. Fixes the `shape` signature's scale mismatch: it is averaged raw instead of L2-normalised, so a live signature and its own gallery entry are finally comparable and the feature stops scoring **0 for the correct person**. `MIN_SHAPE_SCORE` (0.36) and `EVIDENCE_MIN_PART` (0.24) are **unchanged on purpose** — the fix makes them reachable, not retuned. `SCAN_CACHE_VERSION` 11 → 12, since a cached version-11 `shape` is a unit vector the corrected comparison misreads. Adds `test/shape-signature.test.js` (8 cases through the real extraction path) and the `npm run eval:shape` harness. See [the bug report](docs/shape-feature-bug.md) and [the evaluation](docs/shape-normalisation-evaluation.md) |
| `luxkaiwalker/scan-optimisation` | **merged** | Select-then-embed: OSNet now runs on the frames backing chosen samples rather than every usable frame, pose becomes a rescue-only pass, detection moves to 512 px, thumbnails deferred. **240 → 150 model inferences per scan.** Plus rewritten scanning/detection/identification docs |
| `luxkaiwalker/roster-fanout` | **merged** | The server half of the "nothing happens after a scan" complaint. The `roster` message carried every player's full gallery and was re-sent to everyone whenever anyone scanned, i.e. **N × N copies of ~190 KB per scan** (7.8 MB for six players, over captive-portal wifi). It is now a per-connection delta: membership always complete, a gallery attached only to the phone that doesn't have it yet. **6 players: 7782 → 1148 KB per scan; the scanning phone's own wait 1297 → 191 KB, flat in room size.** Poll responses also lost `json.dumps`' default whitespace (~13%) |
| `luxkaiwalker/startup-latency` | **merged** | Two user-reported waits. **Join → lobby:** the lobby now opens on camera + object detector alone (7.25 MB) instead of all three MediaPipe models (17.1 MB), with pose and the embedder created in parallel behind it and `connect()` dialled *before* the wait so the lobby arrives populated. Enrolment waits for the models it enrols with, so nothing degrades a gallery silently. **After the rotation:** the idle scan screen was running full-resolution object+pose on every video frame through the countdown *and* the recording (~360 inferences, more than the entire processing pass) — now a throttled object-only preview, off during recording. OSNet's deferred pass is pipelined into `reid.js`'s worker instead of serialised. New `startup.js` and `scan-reid.js`; 26 new tests |
| `luxkaiwalker/camera-zoom` | **ready, not merged** | LuxKaiwalker branch. Extends identification range by zooming the **camera sensor** during gameplay (`?zoom=`, off by default), which is the only option costed for this that has **no per-frame cost** — it changes what the sensor delivers rather than adding inference — and the only one that helps both halves of the problem: the object detector sees a larger person *and* OSNet gets a larger, sharper crop. **Enrolment deliberately stays at 1×** whatever `?zoom=` says, because galleries are shared between phones and each phone has its own zoom capability, so "the same zoom for both" is not available and 1× is the one level every phone agrees on; `SCAN_CACHE_VERSION` is unchanged. Degrades to today's behaviour completely on a device without zoom (one probe, then never again; `advanced` constraint so a half-supporting device still gets a stream; nothing awaited on the lobby-gate path). New `camera-zoom.js` with no imports, following `startup.js`'s precedent, because `camera.js` cannot be imported under Node. 34 new tests, each mutation-checked. **Informed by but not reusing `335ccac`** — see the note below |
| `luxkaiwalker/asset-delivery` | **merged** | LuxKaiwalker branch. Static delivery only — no client code. Every static response was `no-store` with ETags off, so the **~18 MB of models plus the 11–14 MB WASM runtime were re-fetched on every page load, reload and rejoin**, and nothing was compressed. Now split **by path**: `/models/` and `/vendor/` are cacheable with ETag revalidation (300 s / 1 day), while the app shell stays `no-store` so `git pull && docker compose up --build -d` still takes effect at once. `gzip on` covering text and `application/wasm` — the WASM shrinks ~70%, the models only 7.9–14.0% and so are deliberately excluded (measured, tabulated in [the Docker doc](docs/operations/docker.md#compression)). `/events/` and `/api/` get an explicit `gzip off` on top of the existing `proxy_buffering off`. Adds `test/asset-delivery.test.js` (7 Docker-free checks on the shipped config). Touches no file any other branch in this session touches |

| `luxkaiwalker/range-reid-gate` | **pending** | LuxKaiwalker branch. Players past ~10–12 m were never identified **at any score**: `MIN_MATCH_HEIGHT_RATIO` (0.18 of frame height, 130 px at 720p) made `extractSignature` stamp `usable: false` and `bestAngleScore` return `null`. Not a relaxed constant — below 0.18 a box now reaches a **far band** where only re-identification may score it, and only against a *stricter* bar (the squared shortfall below 0.18, 0 at the line and +0.11 at the floor, i.e. 0.76 there). Both floors are read off OSNet's own 128 × 256 input at the 4×-upscale point (0.09 height, 0.025 width), so the band buys ~1.6× range for a standing person: **10–12 m → 16–19 m**. `MIN_MATCH_HEIGHT_RATIO`, `REID_DEFAULT_THRESHOLD`, `MIN_SHAPE_SCORE`, `EVIDENCE_MIN_PART` and every weight are **unchanged**; at or above 0.18 the whole match object is identical to a pre-band one and `npm run eval:shape` is byte-identical over its 2880 sightings. Also stops the waste it uncovered: `reid.request` ran before `matchGallery` and was never gated by `usable`, so every too-small box bought a full 128 × 256 OSNet inference per check whose result was then discarded. Exports the three thresholds `tools/shape-evaluation.mjs` had to mirror by value, and `test/range-reid-gate.test.js` (11 cases through the real pixel path, each mutation-checked). Its `rangeDiagnostics()` counters and the `?debug` range readout they fed were deleted by `luxkaiwalker/restore-tracking-rate` once the band itself had settled the question they existed to answer |
| `luxkaiwalker/restore-tracking-rate` | **pending** | LuxKaiwalker branch. Started as a regression fix and became the rate work. **The regression:** `loop()` skipped a due detection whenever `navigator.scheduling.isInputPending()` reported input waiting, bounded at 140 ms from when the detection came due. On a phone the player's thumb rests on the FIRE button, so Chromium reports pending input (touchmove included) nearly continuously — the deferral fired on almost every frame and stretched a 120 ms interval to as much as **260 ms, less than half the tracking rate**. A fix that worked in theory and failed on contact with a real hand; deleted, with no cleverer replacement, since `DETECT_MAX_BUSY_SHARE` is what actually bounds main-thread occupancy. **The rates, now three instead of one:** detection 120/180 ms → **50 ms searching / 100 ms settled (20 fps / 10 fps)**; identification `RECHECK_MS` 250 → **100 ms (10 Hz)**; and a new `REID_REQUEST_MS` of **220 ms (~4.5 Hz)** splitting OSNet off from identification, because `reid.request()` does a 128 × 256 `getImageData` readback *synchronously on the main thread* — ~1.3 Mpx/s at 10 Hz with four people. 20 fps is stated as a **target**: at the one measured 23 ms it is 46% duty and reached outright, below ~35 ms it is reached, and above that `max(base, inferenceMs/0.7)` holds the rate down instead of stuttering. **Prioritising a lost person:** `detectTier()` gives the fast tier *and* a 200 ms pose interval (from 520 ms) to a track the detector missed this cycle, the fast tier alone to an unidentified one, and the settled tier to everything found — paying the settled tier is what funds the fast one. No tier for "an enrolled player has no track": indistinguishable from someone who walked off, and the escalation would never end. **Four check counts rescaled** because they were durations written as counts: `REID_REVOKE_CHECKS` 3 → 8, `SWITCH_STREAK` 4 → 10, `INITIAL_STREAK` 2 → 5, `SETTLE_CHECKS` deleted. Leaving them would have made a 300 ms motion blur revoke a real player's name. **Deleted ~2,400 lines of instrumentation:** `input-latency.js` + 4 test files (~1,750 lines for a `?debug` readout nothing could act on once the deferral was gone), `range-readout.js` + 2 test files + `identify.js`'s write-only `rangeDiagnostics()` counters, the `<pre id="debug">` reparenting, `track.lastEnrichedAt`, and the `openGameEvents()` call site. `?debug` line 1 now reads `draw 58 fps · det 19/20 · id 10/10 Hz lost` — the old single `fps` meant *detections* and was read as frame rate. Adds `test/detect-cadence.test.js` (13 cases over the real loop, each mutation-checked; 4 asserted nothing on the first pass) |
| `detection-tuning` (Basiliskenzahn) | **merged, minus two things** | The larger performance change in this area: colour features skipped when re-identification covers the room, OSNet in a Web Worker, velocity-projected boxes, a 3 s median over re-id scores, and every re-id gate tied to one `?reid=`-tunable accept threshold (0.65 instead of a frozen 0.72). See the two exclusions below |

### What was deliberately left out of `detection-tuning`

Merged as `git merge --no-ff 3a9f783`, i.e. the branch **minus its tip commit**:

- **`335ccac` (camera zoom) is excluded.** The merge stops at `3a9f783`, one commit earlier.

  Worth being precise about what that commit is, because its subject line has caused confusion:
  despite the name, **it contains no camera zoom at all.** It adds a *digital crop* pass —
  `detectZoomedPeople`, a second object-detector inference on the central 1/2.5 of each frame on
  every second detection, plus `mergeZoomedPeople`, `ZOOM_FACTOR` and `ZOOM_EDGE_RATIO` in
  `detector.js`. It also lowers the live size gate (`MIN_MATCH_HEIGHT_RATIO` 0.18 → 0.07 plus a
  96 px floor) and writes `docs/development/detection-tuning.md`.

  `luxkaiwalker/camera-zoom` is a **fresh implementation informed by it, not a reuse.** The crop
  pass was rejected: by its own measurements it costs a third of the detection rate (6.7–9.5 → 5.7–6.1
  detections per second), it only helps the detector — the crop is taken *after* detection, so
  OSNet still embeds the same small region of the same frame and gets no extra pixels — and it
  only covers the middle of the picture. Sensor zoom costs nothing per frame and fixes both halves.

  There is one more difference that decides it. The live size gate on this branch is still
  `MIN_MATCH_HEIGHT_RATIO` **0.18** (`identify.js`), i.e. a box must be 18% of the frame's height
  to be identified at all. The crop pass maps its boxes back into full-frame coordinates, so a far
  person's *share of the frame* is unchanged by it and still fails that gate — which is precisely
  why `335ccac` also had to lower the gate to 0.07/96 px, accepting much smaller crops into
  recognition. Sensor zoom instead makes the person genuinely larger in the frame: at 2×, someone
  at 12% of frame height becomes 24% and clears the existing 0.18 honestly, with real pixels rather
  than a relaxed threshold. So zoom needs no gate change to pay off, and that is the main reason it
  was chosen over reusing the crop pass.

  The two are nevertheless **complementary rather than competing**, and composable: they touch
  different files (`detector.js` vs `camera-zoom.js`) and different stages, so taking the crop pass
  later is still open. Its lowered size gate is a separate decision from either — see the open item
  below.
- **The 80/120 ms detection cadence is not taken.** `GAME_ACQUIRE_DETECT_INTERVAL_MS` /
  `GAME_TRACK_DETECT_INTERVAL_MS` stay at **120 / 180 ms**. His `DETECT_MAX_BUSY_SHARE` (0.7) *is*
  kept, which is safe in either direction: it can only *lengthen* the interval on a phone that
  can't keep up, never shorten it below the 120/180 floor.
- **`MOTION_ENABLED` stays opt-in.** His branch reverts it to `motionMode !== 'off'` (motion on by
  default); this branch keeps `=== 'on' || === 'strict'`, matching `b88154f` on `dev`. His score
  nudge is ported onto the provider seam instead of reinstating the old wiring: `motion-identity.js`
  exports a `scoreAdjust` provider method, and `screens/game.js` passes
  `identity.scoreAdjust ?? null` — so with the appearance provider installed the adjustment is
  simply absent rather than conditionally skipped. **Flag for review:** if the intent is to ship
  motion on by default, that is a one-line change in `env.js`, not a re-merge.

### Breaking change to be aware of

`motion-identity.js` now exports **only** `motionIdentity`. `startMotion`, `onRemoteMotion`,
`recordTrackMotion`, `resolveIdentity` and `motionDebugLine` are no longer exported, and
`state.motion` / `state.remoteMotion` / `state.trackMotion` are gone (the provider keeps its own
module-private state and a `WeakMap` keyed on tracks).

That is the point — it's what makes the feature removable — but it means any branch that imported
those names needs rework before it can rebase onto this. `luxkaiwalker/motion-only-tracking` is
the known case: it imports four of them and adds a `track.motionBreakdown` field, which now has
to become another entry in the provider's `WeakMap` rather than a property on the track.
>>>>>>> 6120b24 (Document the three rates, and state 20 fps as a target rather than a promise)

## Held back from the PR into `dev`

**The CI workflow.** `.github/workflows/ci-cd-action.yml` is byte-identical to `dev` here -
reverted on purpose, so the pull request carries **no CI diff at all**. Deploy behaviour is shared
infrastructure that affects everyone, and bundling it with a prune would mean one review covering
both.

The worked version is preserved on **`luxkaiwalker/deploy-robustness`** and is worth its own PR.
It moves the trigger from `pull_request: types: [closed]` to `push: branches: [dev]` (so a PR
closed *unmerged* stops being a case rather than being filtered out by an `if:`), adds a `test`
job both triggers run with `deploy: needs: test`, pins the deployed tree to `${{ github.sha }}`
instead of `git pull`, and adds `concurrency`, `timeout-minutes`, `permissions: {}` and an image
prune. `docs/operations/deployment.md` documents today's behaviour, including the unmerged-close
hazard, and points at that branch.

Five tests that pinned the new workflow were removed with it; a sixth kept its
`package.json` ↔ compose half and dropped its `node-version:` arm, with a comment saying to
restore it if that branch lands.
