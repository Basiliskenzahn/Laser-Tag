# Testing

Two separate test suites: JS (`node --test`, for the client) and Python (`unittest`, for the
backend). Neither needs a dependency beyond the project's own.

## Running the JS suite

In Docker, with nothing installed locally:

```bash
docker compose run --rm tests
# Windows: scripts\test.ps1
```

Or with Node 20+:

```bash
npm install
npm test
```

`npm test` runs:

```
node --test test/*.test.js frontend/public/identify.test.js
```

That is: the browser-free client suites in `test/`, and the tracker test that sits next to `identify.js`. 64 cases in total.

`tools/shape-evaluation.mjs` is deliberately **not** in that glob — it is a measurement
instrument, not a regression gate. Run it on its own with `npm run eval:shape`; what it measures
is written up in [the shape evaluation](../shape-normalisation-evaluation.md).

## Running the Python suite

In Docker:

```bash
docker compose run --rm backend-tests
```

Or with Python 3.12+ and the backend's own dependencies:

```bash
pip install -r backend/requirements.txt
python -m unittest discover -s backend -p "test_*.py" -v
```

`backend/test_models.py` and `backend/test_protocol.py` are a from-scratch port of the Node
implementation's archived test suites (`deprecated/server/game.test.js`,
`deprecated/server/realtime.test.js`) against the Python backend that's actually deployed -
written when it turned out, during an unrelated cleanup, that `backend/` had no tests of its own
at all (see [Streamlining](../streamlining.md) for that history). `test_models.py` uses
`unittest.TestCase` with a fake clock (`room.now = lambda: t`, since `Room.now()` isn't
constructor-injectable in Python the way the Node version was); `test_protocol.py` uses
`aiohttp.test_utils.AioHTTPTestCase` to drive the real `create_app()` with polling clients, exactly
like phones do - no mocking of `Room`/`Session` internals in either suite.

## What's covered

### `backend/test_models.py`: game rules

Unit tests for the `Room` class, 18 cases: starting needs 2 players and full scans, room capacity,
no joins mid-round, no shots during countdown, damage and cooldown, no self-targeting, an
unhashable zone/target id (a JSON list or object) being a clean error rather than the `TypeError`
it used to crash with, knockouts and winners, free-for-all eliminations and leaving mid-round, that
`roster()` carries galleries while `snapshot()` doesn't, and debug-clone gallery mirroring in both
directions.

Plus the bookkeeping behind [the roster delta](../server/protocol.md#the-roster-delta): a roster
entry can omit its gallery while still carrying the identity half; every gallery write moves
`gallery_rev` and a refused scan does not; and a clone's `mirrored_gallery_rev()` moves exactly
when the owner's gallery does, which is what stops a phone matching a clone against a replaced
scan.

### `backend/test_protocol.py`: HTTP/SSE protocol

Drives the real aiohttp app with polling clients (connect, send, poll, disconnect - just like
phones), 19 cases: joining and starting, launching only once everyone is scanned, resuming with a
remembered player id, immediate removal on disconnect, debug clones (mirroring scans both ways,
being targetable instead of the owner, self-hits on the real player rejected with `400`), a full
room of 8, a held poll answered promptly, `410` for unknown sessions, `POST /api/hit` damage
reaching both players over their poll loops and producing an SSE `health` event, a three-player
free-for-all fought entirely over `/api/hit`, and motion samples being sanitised and relayed to
everyone except the sender.

Five of those cover [the roster delta](../server/protocol.md#the-roster-delta), with realistically
sized (~190 KB) galleries so the cost assertions mean something: a scan reaching every phone while
costing the room one gallery per phone rather than N×N — asserted both as a count of galleries on
the wire and in bytes off `poll_bytes`, which is the guard against the quadratic fan-out coming
back; joins and leaves updating membership without re-shipping scans; a reconnecting phone being
sent the roster complete and current; back-to-back rescans converging everywhere on the later one;
and a rescanned owner updating the clone's entry on every phone.

Because the roster is a delta, `last_roster()` in that file merges the whole message history the
way the client's `mergeRoster()` does, rather than reading the last message. Every roster
assertion is therefore about what a phone *holds*, not which bytes one message carried — and
`client.since(mark)` is how the cost assertions ask what an action actually sent.

`rooms`/`connections`/`pollers`/`sse_clients` in `backend.transport` are module-level globals
shared by the whole test process (there's no per-test app state to reset) - every test uses a
**unique room code**, same as the Node suite did.

Every shot in this suite goes through `POST /api/hit`, matching the real client - see
[Streamlining](../streamlining.md) for why the session-based `{"type": "shoot"}` message these
tests originally used no longer exists.

### `frontend/public/identify.test.js`: tracker

Checks that when two visible tracks carry the same player id, only the higher-scoring one keeps it. `identify.js` is mostly browser code (canvas, MediaPipe), so only canvas-free parts like the tracker's bookkeeping can be tested under Node.

### `test/reid-matching.test.js`: matching with re-identification embeddings

Drives `matchGallery()` and `averageSignatures()` with synthetic 512-dimensional unit vectors at chosen cosine similarities, and colour parts deliberately set to look like a perfect match so only the `reid` score can decide. Covers: the re-identification score deciding when both sides have one; a bystander being rejected in closed-set mode *despite* matching colours; two players scoring alike being a tie rather than a guess; galleries without `reid` falling back to the old colour behaviour; and averaged scan samples keeping a normalised embedding.

This is the suite that pins down the priority rules described in [Identification](../client/identification.md#the-signals-in-order-of-strength) — it needs no browser because the embedding is just a vector by the time matching sees it.

### `test/shape-signature.test.js`: the `shape` feature

The one suite that drives signature *extraction*, not just matching. `test/fixtures/synthetic-frame.mjs` stands in a canvas that resamples a synthetic frame — flat coloured bands for head, shirt, accent stripe and trousers — the way `drawImage` would, so `extractSignature()` runs for real under Node. That matters here specifically: the bug these tests exist for ([the shape report](../shape-feature-bug.md)) lived in the **seam** between extraction and `averageSignatures()`, and every test that hand-builds a gallery misses it by construction. The pre-existing 24 pass with the bug present; all eight of these fail.

Covers: a signature scoring ~1 for `shape` against a gallery entry built from itself; a gallery `shape` staying a readable aspect ratio rather than a unit vector (while `hist`/`lower`/`grid` stay normalised); `shape` not drifting when the same person is further from the camera; a clearly different body aspect still scoring low, and an in-between build scoring in between, so the feature still discriminates; the worked example from the bug report; that the re-identification path's score, accept decision and rejection reason are bit-for-bit unchanged even with an absurd `shape` in the gallery; that the MobileNet-embedding path *does* change, by exactly `EMBED_SHAPE_WEIGHT × Δshape`; and that a colour-only check can clear `EVIDENCE_MIN_PART` on all four parts at all, which it never could before.

### `test/roster.test.js`: folding in the roster delta

Drives `mergeRoster()` from `frontend/public/roster.js`, the client half of [the roster
delta](../server/protocol.md#the-roster-delta). Covers: an entry without a `gallery` keeping the
one the phone holds; membership arriving wholesale so leavers and joiners land correctly; a player
never seen before whose gallery was withheld reading as simply unscanned; an explicit `gallery: []`
*not* being mistaken for a withheld one (which would resurrect a scan the room no longer has); a
full roster replacing everything, as a reconnect receives; and the merge not mutating its input.

`roster.js` imports `state.js`, which imports `env.js`, which reads the query string and the
camera elements at import time — so the test stubs `location` and `document` rather than standing
up a DOM. `mergeRoster` itself is pure.

### `test/startup-sequencing.test.js`: what the player waits for

Drives `startup.js` with a deferred promise per model and a hand-cranked clock, so every assertion is about *ordering* rather than about outcomes. Covers: the lobby gate being camera + object detector and nothing else; pose and the embedder being created in parallel with each other; neither starting before the object detector's delegate is known; a GPU→CPU fallback putting all three on the same delegate; re-identification not waiting for the MediaPipe bundle at all; optional models landing and being warmed whenever they arrive, including after the lobby is already open; a model that fails landing as `null` without rejecting the gate; and the recorded timings.

These are deliberately ordering tests rather than "do the models load" tests, because a test of the latter kind would still pass if someone put the optional models back on the critical path — which is exactly the bug the module exists to prevent. See [What Continue actually waits for](../client/app-flow.md#what-continue-actually-waits-for).

### `test/scan-model-gate.test.js`: what enrolment waits for

The other side of the same change. The lobby no longer waits for the embedder or the recogniser, so a scan could now begin before they arrive — and a scan without them does not fail, it quietly enrols weaker signatures into a gallery that is then cached and matched against for the whole round. Covers: there being something to wait for while the lobby is open and the models are not; the wait ending as they land; a model that *failed* not being waited for, since `null` is its final answer; a hung download degrading the scan rather than trapping the player on the scan screen; and the normal case costing nothing.

### `test/scan-reid.test.js`: the deferred OSNet pass

Tests `scan-reid.js` against a fixture of five samples — both shapes `selectRotationSamples()` produces — with two frames deliberately shared between samples. The headline test embeds that fixture through both the real batched implementation and a naive serial reference and asserts the resulting vectors are identical, because the gallery not changing is the thing that matters. Also covers: a shared frame being embedded once; at least `REID_DISPATCH_BATCH` embeddings genuinely in flight at once (this fails if someone puts the per-frame `await` back); a cancel leaving every signature untouched and dispatching no further batch; a failed inference failing the whole scan rather than a gallery with holes; honest per-frame progress; and the averaging arithmetic.

### `test/motion.test.js`: motion matching

Tests `resample()`, `visualActivity()`, `motionCheck()` and `fuseMotion()` from `frontend/public/motion/matching.js` against a simulation: a seeded random walk/stand schedule, an accelerometer series at 10 Hz on the phone's own clock, and camera boxes at ~7 detections per second with detector jitter.

Covers: interpolation and gap handling; the real player matching their own phone across five seeds; at most 2 of 30 bystanders matching by coincidence (and at least 12 of 30 clearly rejected); tolerance of a 300 ms clock offset; `unknown` when nobody moves; panning bins being masked out (the same corrupted series matches with the ego mask and fails without it); and every branch of the fusion table — confirm, veto, correct, classifier-only, motion-only, ambiguous, self and `requireMotion`.

The thresholds in `motion/matching.js` were chosen against this simulation, so changing them will usually show up here first.

## What isn't covered

- **`backend/sanitize.py`'s edge cases beyond what the protocol tests exercise incidentally** (e.g. the motion-samples test covers non-finite/negative/malformed values, but gallery sanitising only gets covered via whatever `GALLERY` fixtures the other tests happen to send). Worth a dedicated unit test file if `sanitize.py` grows more rules.
- **Detection, scanning, and most of signature extraction.** These need a real browser, camera and models. Test them by hand with `?debug`. The exception is the canvas-read half of `extractSignature()`, which `test/fixtures/synthetic-frame.mjs` now makes testable — the pattern is reusable for the other colour features if a reason comes up. What it cannot stand in for is real pixels: a synthetic flat-colour person says nothing about whether a histogram discriminates real clothing.
- **The re-identification model itself.** `reid.js` needs ONNX Runtime Web, a canvas and the model file, so nothing exercises the loading, pre-processing or the request/collect queue. Only the matching rules built on its output are tested.
- **The motion sensor.** `motion/sensor.js` needs `devicemotion` events; only the pure matching half is tested. Its accuracy numbers come from simulation, not from real phones.
- **CI.** The deploy workflow doesn't run either test suite. Run them before merging - see [Streamlining](../streamlining.md).

## Writing tests

- Put browser-free client tests in `test/`. Keeping the pure logic in modules with no browser APIs (as `motion/matching.js` does) is what makes this possible — prefer that over mocking `window`.
- A new JS file under `test/` is picked up by the glob in the `test` script automatically. Anywhere else, add it to that script in `package.json`.
- A new Python file under `backend/` matching `test_*.py` is picked up by `python -m unittest discover` automatically - no registration needed.
- For backend protocol tests: use a **unique room code per test** (`unique_room()` in `test_protocol.py`), since the module-level registries in `backend.transport` are shared across the whole test process. For model tests: fake the clock with `room.now = lambda: t` rather than real `time.sleep()`.
