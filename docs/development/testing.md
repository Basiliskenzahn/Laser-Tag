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
node --test server/*.test.js test/*.test.js public/identify.test.js
```

That is: the two server suites, the two browser-free client suites in `test/`, and the tracker test that sits next to `identify.js`.

## What's covered

### `server/game.test.js`: game rules

Unit tests for the `Room` class with an injected fake clock, so countdowns and cooldowns are tested without waiting:

```js
let t = 0;
const room = new Room('test', { now: () => t });
t += COUNTDOWN_MS; // skip the countdown
```

Covers: starting needs 2 players and full scans, room capacity, no joins mid-round, no shots during countdown, damage and cooldown, no self-targeting, knockouts and winners, free-for-all eliminations, leaving mid-round, and that `roster()` carries galleries while `snapshot()` doesn't.

### `server/realtime.test.js`: protocol

Starts a real `http.Server` on a random port with `handleHttp` and drives it with `fetch`-based polling clients, just like phones do. Helpers:

- `pollingClient()`: connects, polls in the background into a `messages` array, and exposes `send`, `disconnect` and `stop`.
- `waitFor(check)`: waits until a condition holds (2 s default timeout).
- `readSseEvent(response, type)`: reads one named event from an SSE stream.

Covers: joining and starting, launching only once everyone is scanned, resuming with a remembered player id, immediate removal on disconnect, debug clones (mirroring scans both ways, being targetable), a full room of 8, held polls answered promptly, `410` for unknown sessions, damage over polling, a three-player free-for-all, and `/api/hit` producing an SSE `health` event.

Some tests wait out the real countdown (`COUNTDOWN_MS`, 3 s on the Node side) and allow up to 7 s for the round to reach `playing`, so the suite takes several seconds.

### `public/identify.test.js`: tracker

Checks that when two visible tracks carry the same player id, only the higher-scoring one keeps it. `identify.js` is mostly browser code (canvas, MediaPipe), so only canvas-free parts like the tracker's bookkeeping can be tested under Node.

### `test/reid-matching.test.js`: matching with re-identification embeddings

Drives `matchGallery()` and `averageSignatures()` with synthetic 512-dimensional unit vectors at chosen cosine similarities, and colour parts deliberately set to look like a perfect match so only the `reid` score can decide. Covers: the re-identification score deciding when both sides have one; a bystander being rejected in closed-set mode *despite* matching colours; two players scoring alike being a tie rather than a guess; galleries without `reid` falling back to the old colour behaviour; and averaged scan samples keeping a normalised embedding.

This is the suite that pins down the priority rules described in [Identification](../client/identification.md#the-signals-in-order-of-strength) — it needs no browser because the embedding is just a vector by the time matching sees it.

### `test/motion.test.js`: motion matching

Tests `resample()`, `visualActivity()`, `motionCheck()` and `fuseMotion()` from `public/motion/matching.js` against a simulation: a seeded random walk/stand schedule, an accelerometer series at 10 Hz on the phone's own clock, and camera boxes at ~7 detections per second with detector jitter.

Covers: interpolation and gap handling; the real player matching their own phone across five seeds; at most 2 of 30 bystanders matching by coincidence (and at least 12 of 30 clearly rejected); tolerance of a 300 ms clock offset; `unknown` when nobody moves; panning bins being masked out (the same corrupted series matches with the ego mask and fails without it); and every branch of the fusion table — confirm, veto, correct, classifier-only, motion-only, ambiguous, self and `requireMotion`.

The thresholds in `motion/matching.js` were chosen against this simulation, so changing them will usually show up here first.

## What isn't covered

- **The Python backend.** Production runs `backend/app.py`, but every server test targets the Node implementation. Behaviour is only verified to match by keeping the code in sync. If you change the Python side, a quick way to check it is to run the frontend and backend in Docker and play through the change with [debug mode](debug-mode.md).
- **Detection, signatures and scanning.** These need a real browser, camera and models. Test them by hand with `?debug`.
- **The re-identification model itself.** `reid.js` needs ONNX Runtime Web, a canvas and the model file, so nothing exercises the loading, pre-processing or the request/collect queue. Only the matching rules built on its output are tested.
- **The motion sensor.** `motion/sensor.js` needs `devicemotion` events; only the pure matching half is tested. Its accuracy numbers come from simulation, not from real phones.
- **CI.** The deploy workflow doesn't run tests. Run them before merging.

## Writing tests

- Put game-rule tests in `server/game.test.js` and use the fake clock rather than real timers.
- Put protocol tests in `server/realtime.test.js`. Use a **unique room code per test**, since server state is shared across tests in the same process.
- Put browser-free client tests in `test/`. Keeping the pure logic in modules with no browser APIs (as `motion/matching.js` does) is what makes this possible — prefer that over mocking `window`.
- Call `client.stop()` at the end of a test so its background poll loop ends.
- A new file under `server/` or `test/` is picked up by the globs in the `test` script automatically. Anywhere else, add it to that script in `package.json`.
