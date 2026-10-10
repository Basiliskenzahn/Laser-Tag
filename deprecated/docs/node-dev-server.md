# Node dev server

The `server/` folder holds a Node.js implementation of the game server. It's a single process that serves the client **and** runs the game, which makes it convenient for local development. It's also the implementation the automated tests exercise.

Docker and production use the [Python backend](python-backend.md) instead.

## Running it

Requires Node.js 20 or newer.

```bash
npm install
npm start        # node server/index.js
npm run dev      # same, restarting on file changes (node --watch)
```

| Address | Use |
| --- | --- |
| `http://localhost:3000` | Laptop browser |
| `https://<lan-ip>:3443` | Phones (self-signed certificate) |

The LAN addresses are printed on startup.

| Environment variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `HTTPS_PORT` | `3443` |

## Files

| File | Role |
| --- | --- |
| `server/index.js` | HTTP and HTTPS servers, static files, certificate |
| `server/realtime.js` | Rooms, sessions, polling, SSE, hits: the protocol |
| `server/game.js` | `Room` class: the pure game rules, no I/O |
| `server/game.test.js` | Unit tests for `game.js` |
| `server/realtime.test.js` | Protocol tests that drive `realtime.js` over real HTTP |

Client-side logic that can run without a browser is tested from `test/` instead; see [Testing](../development/testing.md).

### `index.js`

- Every request goes to `handleHttp()` from `realtime.js` first. Anything it doesn't handle is served as a static file.
- Static mapping: `/vendor/tasks-vision/` → `node_modules/@mediapipe/tasks-vision/`, `/vendor/ort/` → `node_modules/onnxruntime-web/dist/` (for the [re-identification model](../client/identification.md#the-re-identification-embedding-reidjs)), everything else → `public/`. Paths that escape those folders are refused.
- Files are sent with `Cache-Control: no-cache` and a MIME type from a small table (including `.mjs` and `.wasm`, which MediaPipe needs).
- On first run it generates a self-signed certificate for `laser-tag.local`, valid for one year, using the `selfsigned` package, and stores it in `.certs/` (git-ignored). Delete that folder to get a new one.

### `realtime.js`

Exports a single function, `handleHttp(req, res)`, which returns `true` if it handled the request. That makes it easy to mount in any `http.Server`, which is how the tests use it.

Internally:

- `openSession(conn)` is transport-independent: it takes an object with `send(msg)` and returns `{receive, close}`. The polling code supplies the `send` that queues messages.
- `pollers` maps tokens to `{queue, waiting, waitTimer, lastSeen, session}`. `flush()` answers the waiting poll with everything queued.
- `sweepPollers()` runs every 10 s and closes sessions that haven't been seen for 30 s and have no open poll.
- `eventStreams` maps room codes to open SSE responses.
- `motion` messages are the only ones that don't touch the `Room`: they're sanitised (`cleanMotionSamples`) and forwarded straight to the other players' connections.
- When a poll is aborted by the phone, the session is marked as seen at that moment, so it gets the full 30 s to come back.

The protocol itself is documented in [API and protocol reference](protocol.md); the rules in [Game rules](game-rules.md).

## Compared with the Python backend

See [Python backend → Differences](python-backend.md#differences-from-the-node-server). Keep them in sync when changing either one.
