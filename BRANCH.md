# `luxkaiwalker-dev` — integration branch

**Owner: LuxKaiwalker.** A staging branch, not a feature branch and not a deploy target.

## Purpose

Collect the work from one working session, verify it together, and open **one** pull request into
`dev` rather than several competing ones. Several of the changes below touch the same files
(`identify.js`, `motion-identity.js`, `env.js`, `screens/game.js`), so merging them here first is
what makes the conflicts resolvable in one pass instead of three.

Nothing lands on `dev` from here until the whole set passes both test suites together:

```bash
npm test                                              # 119 JS tests
python -m unittest discover -s backend -p "test_*.py" # 40 backend tests
```

`npm run eval:shape` is **not** part of that gate — it is a measurement instrument, see the
`shape-normalisation` row below.

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

## What deliberately does *not* merge here

Experiment and test-harness branches stay separate — they are instruments, not product:

| Branch | Why it stays out |
| --- | --- |
| `luxkaiwalker/motion-only-tracking` | Disables appearance identification entirely and stubs the scan gate. A measuring rig for the motion signal; see [the motion-only experiment](docs/motion-only-experiment.md) |
| `luxkaiwalker/motion-capture-harness` | Capture/replay tooling for real accelerometer data. Test infrastructure, so it stays out — but its `backend/sanitize.py` fix **has** been taken here (motion samples were truncated from the oldest end, discarding exactly the recent samples the 6 s correlation window needs), along with `backend/test_sanitize.py`. **Note it is now stale against this branch:** it hooks `motion-identity.js`, which `motion-isolation` has since rewritten |

## Open items

| Item | Owner of the decision | State |
| --- | --- | --- |
| **`MIN_SHAPE_SCORE` / `EVIDENCE_MIN_PART` recalibration.** Deferred out of `luxkaiwalker/shape-normalisation` deliberately. The corrected `shape` gate is now *reachable* at 0.36 and, on synthetic fixtures, rejects 0% of correct pairs and 0% of wrong-person pairs — harmless but near-inert as a way of telling people apart. Whether it should be stricter (or should stop being a hard rejection criterion at all) needs real colour-only `s` scores off a phone where OSNet does not load, via `?debug`. **Do not pick new numbers from the synthetic distributions**; they give the same person the same body aspect by construction and are far too tight. | LuxKaiwalker | open, and deliberately so — the safe state is the one it is in |
| **Motion on by default.** Flagged under the `detection-tuning` exclusions above. | — | open |
| **The live size gate, `MIN_MATCH_HEIGHT_RATIO` (0.18).** The other half of `335ccac`'s range work, and separable from its crop pass: boxes shorter than 18% of the frame are never identified even when detected, which `335ccac` measured as leaving everyone beyond ~6 m unidentifiable and relaxed to 0.07 with a 96 px floor. `luxkaiwalker/camera-zoom` deliberately does **not** touch it — zoom raises a far player's actual share of the frame, so they clear 0.18 on real pixels, and lowering the gate as well would admit genuinely tiny crops into recognition on top of that. Worth deciding on its own, with `?debug` scores from small boxes, and ideally *after* zoom has been tried in the field, since it changes which boxes exist in the first place. Owner of `identify.js` | LuxKaiwalker | open, deliberately deferred |
| **Starting the model fetch earlier.** `luxkaiwalker/asset-delivery` deliberately added **no** `<link rel="preload">` hints and left `frontend/public/index.html` untouched. Two reasons: the WASM path is chosen at runtime after a SIMD probe, so a static hint would have to guess among four variants and a wrong guess costs an unused 11 MB on a phone; and an `as="fetch"` hint for a model has to match the eventual request's CORS/credentials mode or the browser fetches twice, which on the 7.25 MB detector would be worse than the bug. The right mechanism is an explicit `fetch()` warm-up where load order is already being decided — i.e. in the startup-sequencing work, not in the delivery layer. | LuxKaiwalker | open, deferred to whoever owns the startup path |

## Also on this branch

[`docs/detection-pipeline-audit.md`](docs/detection-pipeline-audit.md) — the per-feature audit of
the identification pipeline: what each signal costs, how accurate it is, and which of those
numbers are measured versus simulated. It carries its own "partly superseded" note, since motion
has since become opt-in and `detection-tuning` has improved several of the costs it quotes.

## Related work not from this session

`detection-tuning` (Basiliskenzahn) is merged here, with the exclusions recorded above. It is
**not** merged into `dev` yet — this branch is where it and this session's work meet first.
`luxkaiwalker/tracking-smoothing` deliberately avoided reimplementing its `liveBox()`, so the two
compose rather than collide.
