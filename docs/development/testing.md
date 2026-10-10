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
node --test server/game.test.js server/realtime.test.js public/identify.test.js
```

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

Some tests wait out the real 5-second countdown, so the suite takes several seconds.

### `public/identify.test.js`: tracker

Checks that when two visible tracks carry the same player id, only the higher-scoring one keeps it. `identify.js` is mostly browser code (canvas, MediaPipe), so only canvas-free parts like the tracker's bookkeeping can be tested under Node.

## What isn't covered

- **The Python backend.** Production runs `backend/app.py`, but every server test targets the Node implementation. Behaviour is only verified to match by keeping the code in sync. If you change the Python side, a quick way to check it is to run the frontend and backend in Docker and play through the change with [debug mode](debug-mode.md).
- **Detection, signatures and scanning.** These need a real browser, camera and models. Test them by hand with `?debug`.
- **CI.** The deploy workflow doesn't run tests. Run them before merging.

## Writing tests

- Put game-rule tests in `server/game.test.js` and use the fake clock rather than real timers.
- Put protocol tests in `server/realtime.test.js`. Use a **unique room code per test**, since server state is shared across tests in the same process.
- Call `client.stop()` at the end of a test so its background poll loop ends.
- For a new test file, add it to the `test` script in `package.json`.
