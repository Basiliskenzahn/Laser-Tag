# Contributing

## Project layout

```
public/                 The phone client (static files, no build step)
  index.html            All four screens
  style.css
  app.js                Screens, camera, loop, scanning, shooting, HUD
  detector.js           MediaPipe models, person boxes, hitboxes
  identify.js           Signatures, matching, tracker
  transport.js          Long-polling connection
  sound.js              Synthesised sound effects
  identify.test.js
  models/               Committed .tflite / .task model files
backend/                Python game server (Docker, production)
  app.py
  Dockerfile
  requirements.txt
server/                 Node game server (npm start, tests)
  index.js              Static files + HTTPS
  realtime.js           Protocol
  game.js               Rules
  *.test.js
frontend/               nginx container: Dockerfile, config, cert entrypoint
scripts/                Windows PowerShell helpers
docs/                   You are here
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
- **No runtime dependencies beyond what's there.** The client only uses MediaPipe; the Python server only uses aiohttp; the Node server only uses `selfsigned`. Versions are pinned exactly.
- **Comments explain why**, not what. Modules start with a short header comment describing their role.
- **Small, named constants** at the top of each module rather than magic numbers. Document new tunables in [Configuration](configuration.md).
- **Graceful degradation.** Optional features (pose model, embedder, wake lock, vibration, `localStorage`) are wrapped so a failure never blocks the game.
- **User-facing errors are plain sentences** that say what to do ("step a little closer"), not codes.

## Keep both backends in sync

The game server exists twice: `backend/app.py` (production) and `server/game.js` + `server/realtime.js` (dev and tests). They must behave the same. When you change rules, messages, validation or limits:

1. Make the change in both.
2. Add or update a test in `server/*.test.js`.
3. Check the change by hand against the Python backend in Docker, since nothing tests it automatically.
4. Update [Protocol](../server/protocol.md) and [Game rules](../server/game-rules.md).

Known small differences are listed in [Python backend → Differences](../server/python-backend.md#differences-from-the-node-server).

## Changing the signature format

If you add, remove or resize a signature field in `identify.js`:

- bump `SCAN_CACHE_VERSION` in `app.js` so phones discard old cached scans;
- update `GALLERY_FIELDS` in **both** servers, or the new field is silently dropped;
- check the [gallery size](../server/protocol.md#gallery-format) still fits under `MAX_BODY_BYTES`;
- update the scan cache validator `validScanCache()` if the field is required.

## Updating models or MediaPipe

- Model files live in `public/models/` and are referenced by URL constants at the top of `detector.js`.
- `@mediapipe/tasks-vision` is pinned in `package.json`. After bumping it, run `npm install` to update `package-lock.json`. The frontend image copies the package from `node_modules`, and the Node dev server serves it from there.
- New file types need a MIME type in `frontend/common-locations.conf` and in the `MIME` table in `server/index.js`.

## Known issues and loose ends

Useful starting points if you're looking for something to work on:

- **Trust model:** the shooter's phone decides hits and the server trusts it, so a modified client can cheat.
- **Similar outfits:** players dressed alike are often left unidentified. A stronger re-identification model would help; see [Identification → Swapping in a better model](../client/identification.md#swapping-in-a-better-model).
- **Rectangular hitboxes:** pose landmarks could give body-shaped hitboxes and a precise head position.
- **Solo scanning:** a scan needs a second person holding the phone. A front-camera or mirror mode would remove that.
- **iOS vibration:** Safari doesn't support `navigator.vibrate`.
- **Untested Python backend:** a small pytest suite mirroring `realtime.test.js` would catch drift between the two servers.
- **No CI tests:** the deploy job doesn't run the test suite first.
- **Large galleries:** only `embed` is rounded, so full galleries approach the 256 KB body limit.
- **SSE events are unused** by the client beyond debug logging.
- **Dead code in `app.js`:** `captureScanSignature`, `useSavedScan`, `clearScanCache`, and the empty `updateScanButtons` / `renderSavedScan` are left over from the earlier four-pose scan flow.
- **In-memory state:** restarting the server ends all games.
