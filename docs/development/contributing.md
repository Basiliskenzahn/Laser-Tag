# Contributing

## Project layout

```
frontend/               nginx container AND the phone client it serves
  Dockerfile, nginx.conf, common-locations.conf, entrypoint.sh
  public/               The phone client (static files, no build step)
    index.html          All four screens
    style.css
    app.js              Entrypoint: wires DOM events to the screens
    state.js            The shared state object, localStorage helpers
    env.js               URL-parameter flags, $, shared video/canvas
    roster.js            Read-only lookups over the server's roster/game snapshot
    camera.js            Starting the camera and on-device models, once
    net.js                Long-polling/SSE connection and server-message handling
    motion-identity.js   Motion plumbing + resolveIdentity() (fuses appearance + motion)
    screens/
      join.js, lobby.js, scan.js, game.js
    detector.js          MediaPipe models, person boxes, hitboxes
    identify.js          Signatures, matching, tracker
    reid.js              OSNet re-identification embeddings (ONNX Runtime Web)
    motion/
      sensor.js           This phone's accelerometer/gyroscope activity
      matching.js         Correlating that with on-screen motion; fusing it with the classifier
    transport.js          Long-polling connection (wrapped by net.js)
    sound.js              Synthesised sound effects
    identify.test.js
    models/               Committed .tflite / .task / .onnx model files
backend/                Python game server (Docker, production, and local dev - the only backend)
  app.py                 Entrypoint: route handlers, create_app()
  models.py              Player/Room: pure game rules, no networking
  transport.py           Poller/Session, broadcast, room/connection registries
  sanitize.py            Cleaning every value that comes from the client
  Dockerfile
  requirements.txt
test/                   Browser-free client tests (motion, reid matching)
scripts/                Windows PowerShell helpers
docs/                   You are here
deprecated/             Archived code, not built/run/tested - see deprecated/README.md
docker-compose.yml
.github/workflows/      Deploy job
```

## Workflow

1. Branch off `main`.
2. Run locally: `docker compose up --build`, or `npm run dev` for faster iteration on the client.
3. Test: `docker compose run --rm tests` (or `npm test`). For anything involving the camera, also test by hand with [`?debug`](debug-mode.md), ideally on a real phone.
4. Open a pull request into `main`. Merging (or closing) it **deploys automatically** to the hackathon server. See [Deployment](../operations/deployment.md).

## Conventions

- **No build step and no framework.** The client is plain ES modules loaded straight by the browser. Keep it that way unless there's a strong reason.
- **No runtime dependencies beyond what's there.** The client only uses MediaPipe and ONNX Runtime Web; the Python server only uses aiohttp. Versions are pinned exactly.
- **Comments explain why**, not what. Modules start with a short header comment describing their role, and anything tuned against measurements records the numbers (see the threshold tables in `identify.js` and `motion/matching.js`).
- **Small, named constants** at the top of each module rather than magic numbers. Document new tunables in [Configuration](configuration.md).
- **Graceful degradation.** Optional features (pose model, embedder, re-identification model, motion permission, wake lock, vibration, `localStorage`) are wrapped so a failure never blocks the game. Each one removes a signal and the game falls back to a weaker one; see [the signal order](../client/identification.md#the-signals-in-order-of-strength).
- **Keep browser APIs out of pure logic.** `motion/matching.js` touches no DOM and is therefore unit-tested in Node. Prefer that split for new identification logic over mocking the browser.
- **User-facing errors are plain sentences** that say what to do ("step a little closer"), not codes.

## Changing rules, messages, validation or limits

There's one backend now (`backend/`), but it has no automated tests - see [Testing → What isn't covered](testing.md#what-isnt-covered). When you change rules, messages, validation or limits:

1. Make the change in `backend/models.py` / `backend/transport.py`.
2. Check it by hand against the Python backend in Docker (`?debug` helps), since nothing tests it automatically yet.
3. Update [Protocol](../server/protocol.md) and [Game rules](../server/game-rules.md).

See [Streamlining](../streamlining.md) if you're the one who ends up fixing the missing test coverage - the archived `deprecated/server/*.test.js` suites are a reasonable starting template.

## Changing the signature format

If you add, remove or resize a signature field in `identify.js`:

- bump `SCAN_CACHE_VERSION` in `screens/scan.js` so phones discard old cached scans;
- update `GALLERY_FIELDS` in `backend/sanitize.py`, or the new field is silently dropped;
- check the [gallery size](../server/protocol.md#gallery-format) still fits under `MAX_BODY_BYTES` (and nginx's `client_max_body_size`);
- update the scan cache validator `validScanCache()` if the field is required;
- round the values before they go on the wire, as `compactEmbedding` and `reid.js` do;
- decide how the field combines in `similarityParts()`. If its scores aren't on the same scale as the colour score it needs its own thresholds, which means touching `rejectionReason()`, `evidenceWeight()` and `softLabelMatch()` — all three branch on `hasReid` for exactly this reason — and probably a `TARGET_MIN_*` in `motion-identity.js` too.

`reid` is the worked example of all of the above; see [Identification → Swapping in a better model](../client/identification.md#swapping-in-a-better-model).

## Updating models or MediaPipe

- Model files live in `frontend/public/models/` and are referenced by URL constants at the top of `detector.js` (MediaPipe models) and `reid.js` (the OSNet `.onnx`).
- `@mediapipe/tasks-vision` and `onnxruntime-web` are pinned in `package.json`. After bumping either, run `npm install` to update `package-lock.json`. `frontend/Dockerfile` copies both packages out of `node_modules` (to `/vendor/tasks-vision/` and `/vendor/ort/`) in its build stage.
- New file types need a MIME type in `frontend/common-locations.conf`. (`.onnx` is currently served as `application/octet-stream` by the fallback, which browsers are happy with.) New files anywhere under `frontend/public/` don't need any other Docker change - `frontend/Dockerfile` copies the whole directory.
- Replacing the re-identification model means re-checking `WIDTH`/`HEIGHT`/`MEAN`/`STD` and `REID_DIMS` in `reid.js` and re-measuring `REID_MATCH_THRESHOLD` — a wrong pre-processing step degrades accuracy silently rather than failing.

## Known issues and loose ends

Useful starting points if you're looking for something to work on:

- **Trust model:** the shooter's phone decides hits and the server trusts it, so a modified client can cheat.
- **Similar outfits:** much better since the [re-identification model](../client/identification.md#the-re-identification-embedding-reidjs) landed, but a phone where it fails to load falls back to the colour signature, where players dressed alike are still often left unidentified.
- **Re-identification latency:** the model is asynchronous and a track isn't identified at all until its first embedding arrives, which costs a moment on a newly visible player. A second in-flight inference, or a worker, would cut it.
- **Motion needs permission and movement:** iOS only prompts inside a tap, and two players standing still produce no usable correlation, so motion is a bonus signal rather than something that can be relied on.
- **Rectangular hitboxes:** pose landmarks could give body-shaped hitboxes and a precise head position.
- **Solo scanning:** a scan needs a second person holding the phone. A front-camera or mirror mode would remove that.
- **iOS vibration:** Safari doesn't support `navigator.vibrate`.
- **Untested backend:** `backend/` has no automated tests at all - see [Streamlining](../streamlining.md).
- **No CI tests:** the deploy job doesn't run the test suite first.
- **Large galleries:** the colour fields are still sent at full float precision, so a full gallery is ~210 KB against a 1 MB limit. Fine now, worth watching.
- **SSE events are unused** by the client beyond debug logging.
- **In-memory state:** restarting the server ends all games.
