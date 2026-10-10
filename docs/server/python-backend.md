# Python backend

The Python backend (used in Docker and production) is an [aiohttp](https://docs.aiohttp.org/) application with no other dependencies, split into four modules:

- `backend/models.py` - `Player` and `Room`: pure game rules, no networking.
- `backend/sanitize.py` - cleaning every value that comes from the client (room codes, names, galleries, motion samples) before it touches `models.py`.
- `backend/transport.py` - the long-polling `Poller`, per-phone `Session`, SSE broadcast helpers, and the room/connection registries.
- `backend/app.py` - the entrypoint: the seven route handlers, `create_app()`, and `python -m backend.app`. This is the only module `backend/Dockerfile`'s `CMD` launches.

It serves only `/api/*`, `/events/*` and a health check at `/`. Static files and TLS are handled by nginx in front of it (see [Docker setup](../operations/docker.md)).

## Running it

In Docker (the normal way):

```bash
docker compose up --build backend
```

Directly, for debugging (Python 3.12):

```bash
pip install -r backend/requirements.txt
python -m backend.app          # listens on 0.0.0.0:4000, or $PORT
```

On its own it serves no client. To play against it locally, put something in front that serves `frontend/public/` and proxies `/api/` and `/events/` to it, which is exactly what the `frontend` container does.

## Structure

| Part | Module | What it is |
| --- | --- | --- |
| Constants | `models.py` | `MIN_PLAYERS`, `MAX_PLAYERS`, `MAX_HP`, `DAMAGE`, `SHOT_COOLDOWN_MS`, `COUNTDOWN_MS`, `CLONE_SUFFIX` |
| Constants | `transport.py`/`sanitize.py` | `POLL_WAIT_MS`, `POLL_EXPIRY_MS`, `MAX_BODY_BYTES` (1 MB), `MAX_MOTION_SAMPLES`, `GALLERY_FIELDS` |
| `Player` (dataclass) | `models.py` | id, name, gallery, hp, wins, alive, last shot time |
| `Room` | `models.py` | The game rules: originally a line-by-line port of the now-archived `deprecated/server/game.js`. See [Game rules](game-rules.md). |
| `Poller` (dataclass) | `transport.py` | One polling session: message queue, last-seen time, the pending poll's future, and its `Session` |
| Global dicts | `transport.py` | `rooms` (code → Room), `connections` (player id → Session), `pollers` (token → Poller), `sse_clients` (room code → set of queues) |
| `clean_*` helpers | `sanitize.py` | Input sanitising for room codes, names, player ids, galleries (including the optional `reid` field) and motion samples |
| `broadcast_*`, `process_hit` | `transport.py` | Fan-out of `state`, `roster`, SSE events and hit messages |
| `Session` | `transport.py` | One connected phone: handles `join`, `shoot`, `scan`, `motion`, `start`, and cleans up on `close()` |
| `api_*`, `events`, `health`, `create_app` | `app.py` | HTTP handlers and app assembly - the entrypoint |
| `sweep_pollers` | `transport.py` | Background task: every 5 s, closes sessions not seen for 30 s |
| `create_app()` | Routes and startup/cleanup hooks |

## How a request flows

1. `POST /api/connect` creates a `Poller` with a new `Session`. The session's `sender` appends to the poller's queue and wakes a waiting poll.
2. `POST /api/send` parses the body and hands it to `Session.receive()`.
3. `Session.receive()` mutates the `Room` and calls `broadcast_state()` / `broadcast_roster()`, which call `send_to()` for every player in the room, which pushes onto each player's queue.
4. `GET /api/poll` returns the queue right away, or waits up to 20 s on a future that the sender resolves.

For SSE, each `/events/<room>` request gets an `asyncio.Queue` registered in `sse_clients`. `broadcast_room_event()` puts events on every queue for that room, and the handler writes them out as `event:`/`data:` lines.

## Countdown timer

`broadcast_state()` cancels any pending timer for the room and, if the room is in `countdown`, schedules one more broadcast for 10 ms after the countdown ends. That broadcast is what flips all phones to *playing* at once.

## State and scaling

All state is in process memory. Restarting the container ends every game and drops every scan. It runs as a single process, so it can't be scaled horizontally without moving state to shared storage.

## Behaviour worth knowing

- Session sweep interval: every 5 s, a session with no activity for 30 s is dropped.
- An oversized request body gets `413`, checked from `Content-Length` before the body is read.
- A second `/api/poll` on the same session replaces the first poll's waiter (the earlier one never
  resolves on its own - the client is expected to only hold one poll open per session).
- Body size limit (`MAX_BODY_BYTES`, 1 MB) is enforced by aiohttp's `client_max_size`.
- `/` is a health check, not the client - nginx serves the client's static files.

## Tests

`backend/test_models.py` and `backend/test_protocol.py` are a from-scratch port of the archived
Node suites (`deprecated/server/game.test.js`, `deprecated/server/realtime.test.js`) against this
backend - no new dependency, since `unittest` is stdlib and `aiohttp.test_utils` ships with
`aiohttp`, which is already required. See [Testing](../development/testing.md) for what they cover
and how to run them.
