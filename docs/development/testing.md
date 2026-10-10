# Testing

Two separate test suites: JS (`node --test`, for the client) and Python (`unittest`, for the
backend). Neither needs a dependency beyond the project's own. **Run both before merging** -
nothing in CI runs either of them (see [Deployment](../operations/deployment.md)).

| Suite | Docker | Local | Tests |
| --- | --- | --- | --- |
| JS | `docker compose run --rm tests` | `npm test` | 19 |
| Python | `docker compose run --rm backend-tests` | `python -m unittest discover -s backend -p "test_*.py" -v` | 36 |

Both Docker services use the `test` profile, so `docker compose up` doesn't start them. Docker is
the default: it needs nothing installed locally and pins the same Node and Python versions the
app runs on.

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

That is: the two browser-free client suites in `test/`, and the tracker test that sits next to `identify.js`.

## Running the Python suite

In Docker:

```bash
docker compose run --rm backend-tests
```

Or with Python 3.12 or 3.13 and the backend's own dependencies:

```bash
pip install -r backend/requirements.txt
python -m unittest discover -s backend -p "test_*.py" -v
```

The `pip install` step is not optional: `test_protocol.py` imports `aiohttp.test_utils`, so
without it that whole module fails to import (`ModuleNotFoundError: No module named 'aiohttp'`)
and the run reports one error instead of its 15 tests. Also avoid Python 3.14 for now: the pinned
`aiohttp==3.10.11` predates it and has no prebuilt wheel, so `pip` tries to compile it from source.
The Docker service uses `python:3.12-slim`, the same image as `backend/Dockerfile`.

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

Unit tests for the `Room` class, 17 cases: starting needs 2 players and full scans, room capacity,
no joins mid-round, no shots during countdown, damage and cooldown, no self-targeting, an
unhashable zone/target id (a JSON list or object) being a clean error rather than the `TypeError`
it used to crash with, knockouts and winners, free-for-all eliminations and leaving mid-round,
forfeiting (a knockout that stays on the scoreboard, can decide the round, and is a plain leave
outside a live round), that
`roster()` carries galleries while `snapshot()` doesn't, and debug-clone gallery mirroring in both
directions.

### `backend/test_protocol.py`: HTTP/SSE protocol

Drives the real aiohttp app with polling clients (connect, send, poll, disconnect - just like
phones), 15 cases: joining and starting, launching only once everyone is scanned, resuming with a
remembered player id, immediate removal on disconnect, a mid-round forfeit counting as a death that
can't be resumed, debug clones (mirroring scans both ways,
being targetable instead of the owner, self-hits on the real player rejected with `400`), a full
room of 8, a held poll answered promptly, `410` for unknown sessions, `POST /api/hit` damage
reaching both players over their poll loops and producing an SSE `health` event, a three-player
free-for-all fought entirely over `/api/hit`, and motion samples being sanitised and relayed to
everyone except the sender.

`rooms`/`connections`/`pollers`/`sse_clients` in `backend.transport` are module-level globals
shared by the whole test process (there's no per-test app state to reset) - every test uses a
**unique room code**, same as the Node suite did.

Every shot in this suite goes through `POST /api/hit`, matching the real client - see
[Streamlining](../streamlining.md) for why the session-based `{"type": "shoot"}` message these
tests originally used no longer exists.

### `backend/test_sanitize.py`: motion-sample sanitising

Unit tests for `clean_motion_samples()`, 4 cases: an over-long backlog keeps its *newest* samples
(the 6 s correlation window in `motion/matching.js` needs the recent tail, not the stale head),
short flushes pass through unchanged and in order, junk entries are dropped inside the newest-N
window without letting older samples back in, and non-list input becomes `[]`. The protocol suite
never sends more than the cap, so it can't see which samples survive truncation.

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

- **Gallery sanitising in `backend/sanitize.py`.** Motion samples have their own tests in `test_sanitize.py`, but gallery sanitising only gets covered via whatever `GALLERY` fixtures the other tests happen to send. Add cases to `test_sanitize.py` if `sanitize.py` grows more rules.
- **Detection, signatures and scanning.** These need a real browser, camera and models. Test them by hand with `?debug`.
- **The re-identification model itself.** `reid.js` needs ONNX Runtime Web, a canvas and the model file, so nothing exercises the loading, pre-processing or the request/collect queue. Only the matching rules built on its output are tested.
- **The motion sensor.** `motion/sensor.js` needs `devicemotion` events; only the pure matching half is tested. Its accuracy numbers come from simulation, not from real phones.
- **CI.** The deploy workflow doesn't run either test suite. Run them before merging - see [Streamlining](../streamlining.md).

## Writing tests

- Put browser-free client tests in `test/`. Keeping the pure logic in modules with no browser APIs (as `motion/matching.js` does) is what makes this possible — prefer that over mocking `window`.
- A new JS file under `test/` is picked up by the glob in the `test` script automatically. Anywhere else, add it to that script in `package.json`.
- A new Python file under `backend/` matching `test_*.py` is picked up by `python -m unittest discover` automatically - no registration needed.
- For backend protocol tests: use a **unique room code per test** (`unique_room()` in `test_protocol.py`), since the module-level registries in `backend.transport` are shared across the whole test process. For model tests: fake the clock with `room.now = lambda: t` rather than real `time.sleep()`.
