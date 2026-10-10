# Testing

The tests use Node's built-in test runner (`node:test`). There are no test dependencies beyond the project's own.

## Running

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

That is: the two browser-free client suites in `test/`, and the tracker test that sits next to `identify.js`. There used to be a third category - unit tests for the Node backend's `Room` class and its HTTP/SSE protocol (`server/game.test.js`, `server/realtime.test.js`) - but that backend was archived to `deprecated/server/` (see [Streamlining](../streamlining.md)) along with its tests, which were never ported to the Python backend that's actually deployed. **`backend/` currently has no automated tests at all.**

## What's covered

### `frontend/public/identify.test.js`: tracker

Checks that when two visible tracks carry the same player id, only the higher-scoring one keeps it. `identify.js` is mostly browser code (canvas, MediaPipe), so only canvas-free parts like the tracker's bookkeeping can be tested under Node.

### `test/reid-matching.test.js`: matching with re-identification embeddings

Drives `matchGallery()` and `averageSignatures()` with synthetic 512-dimensional unit vectors at chosen cosine similarities, and colour parts deliberately set to look like a perfect match so only the `reid` score can decide. Covers: the re-identification score deciding when both sides have one; a bystander being rejected in closed-set mode *despite* matching colours; two players scoring alike being a tie rather than a guess; galleries without `reid` falling back to the old colour behaviour; and averaged scan samples keeping a normalised embedding.

This is the suite that pins down the priority rules described in [Identification](../client/identification.md#the-signals-in-order-of-strength) — it needs no browser because the embedding is just a vector by the time matching sees it.

### `test/motion.test.js`: motion matching

Tests `resample()`, `visualActivity()`, `motionCheck()` and `fuseMotion()` from `frontend/public/motion/matching.js` against a simulation: a seeded random walk/stand schedule, an accelerometer series at 10 Hz on the phone's own clock, and camera boxes at ~7 detections per second with detector jitter.

Covers: interpolation and gap handling; the real player matching their own phone across five seeds; at most 2 of 30 bystanders matching by coincidence (and at least 12 of 30 clearly rejected); tolerance of a 300 ms clock offset; `unknown` when nobody moves; panning bins being masked out (the same corrupted series matches with the ego mask and fails without it); and every branch of the fusion table — confirm, veto, correct, classifier-only, motion-only, ambiguous, self and `requireMotion`.

The thresholds in `motion/matching.js` were chosen against this simulation, so changing them will usually show up here first.

## What isn't covered

- **The backend, entirely.** `backend/models.py` (game rules) and `backend/transport.py` (protocol) have no tests. The suites that used to cover this logic (against the now-archived Node implementation) are sitting in `deprecated/server/` and would need porting to pytest (or an HTTP-driven Node test against the running Python process) to mean anything again - see [Streamlining](../streamlining.md). Until then, check backend changes by hand: run the frontend and backend in Docker and play through the change with [debug mode](debug-mode.md).
- **Detection, signatures and scanning.** These need a real browser, camera and models. Test them by hand with `?debug`.
- **The re-identification model itself.** `reid.js` needs ONNX Runtime Web, a canvas and the model file, so nothing exercises the loading, pre-processing or the request/collect queue. Only the matching rules built on its output are tested.
- **The motion sensor.** `motion/sensor.js` needs `devicemotion` events; only the pure matching half is tested. Its accuracy numbers come from simulation, not from real phones.
- **CI.** The deploy workflow doesn't run tests. Run them before merging.

## Writing tests

- Put browser-free client tests in `test/`. Keeping the pure logic in modules with no browser APIs (as `motion/matching.js` does) is what makes this possible — prefer that over mocking `window`.
- A new file under `test/` is picked up by the glob in the `test` script automatically. Anywhere else (including a future `backend/` test suite), add it to that script in `package.json`.
- If you port the archived `server/*.test.js` suites to the Python backend: the fake-clock pattern (`Room('test', { now: () => t })`) and the `pollingClient()`/`waitFor()`/`readSseEvent()` helpers they used are a reasonable template even in pytest - see `deprecated/server/game.test.js` and `deprecated/server/realtime.test.js`.
