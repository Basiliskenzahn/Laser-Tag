# Testing

Two separate test suites: JS (`node --test`, for the client) and Python (`unittest`, for the
backend). Neither needs a dependency beyond the project's own.

## Running the JS suite

In Docker, with nothing installed locally:

```bash
docker compose run --rm tests
# Windows: scripts\test.ps1
```

Or with Node 22+:

```bash
npm install
npm test
```

That runs the browser-free client suites in `test/`, plus the tracker test that sits next to
`identify.js`. The suite is the catalogue of itself - every file opens with a comment saying what
it covers and why, which is more reliable than a list here that goes stale every time a test
moves.

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

`test_models.py` uses `unittest.TestCase` with a fake clock (`room.now = lambda: t`, since
`Room.now()` isn't constructor-injectable); `test_protocol.py` uses
`aiohttp.test_utils.AioHTTPTestCase` to drive the real `create_app()` with polling clients, exactly
like phones do - no mocking of `Room`/`Session` internals in either suite.

## Two conventions worth knowing before you read a test

**Roster assertions are about what a phone holds, not what one message carried.** The `roster`
message is a [delta](../server/protocol.md#the-roster-delta), so `last_roster()` in
`test_protocol.py` merges the whole message history the way the client's `mergeRoster()` does.
`client.since(mark)` is how the cost assertions ask what an action actually sent - and those
assertions, in bytes off `poll_bytes` as well as in galleries counted on the wire, are the guard
against the quadratic fan-out coming back.

**Some suites assert ordering rather than outcomes.** `startup-sequencing` is the example: a test
that merely checked the models load would still pass if someone put the optional ones back on the
critical path, which is the exact bug the module exists to prevent. Those tests use a deferred
promise per model and a hand-cranked clock so every assertion is about sequence.

## What isn't covered

- **`backend/sanitize.py`'s edge cases beyond what the protocol tests exercise incidentally.**
  Gallery sanitising only gets covered via whatever `GALLERY` fixtures the other tests happen to
  send. Worth a dedicated unit test file if `sanitize.py` grows more rules.
- **Detection, scanning, and most of signature extraction.** These need a real browser, camera and
  models. Test them by hand with [`?debug`](debug-mode.md). The exception is the canvas-read half
  of `extractSignature()`, which `test/fixtures/synthetic-frame.mjs` makes testable - the pattern
  is reusable for the other colour features if a reason comes up. What it cannot stand in for is
  real pixels: a synthetic flat-colour person says nothing about whether a histogram discriminates
  real clothing, and that limit is why no threshold should be chosen off it.
- **The re-identification model itself.** `reid.js` needs ONNX Runtime Web, a canvas and the model
  file, so nothing exercises the loading, pre-processing or the request/collect queue. Only the
  matching rules built on its output are tested.
- **CI.** The deploy workflow doesn't run either test suite. Run them before merging - see
  [Open items](../open-items.md).

## Writing tests

- Put browser-free client tests in `test/`. Keeping pure logic in modules with no browser APIs is
  what makes this possible - prefer that over mocking `window`.
- A new JS file under `test/` is picked up by the glob in the `test` script automatically.
  Anywhere else, add it to that script in `package.json`.
- A new Python file under `backend/` matching `test_*.py` is picked up by
  `python -m unittest discover` automatically - no registration needed.
- For backend protocol tests: use a **unique room code per test** (`unique_room()` in
  `test_protocol.py`), since the module-level registries in `backend.transport` are shared across
  the whole test process. For model tests: fake the clock with `room.now = lambda: t` rather than
  real `time.sleep()`.
