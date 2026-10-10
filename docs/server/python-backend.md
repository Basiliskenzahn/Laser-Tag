# Python backend

`backend/app.py` is the game server used in Docker and production. It's a single [aiohttp](https://docs.aiohttp.org/) application with no other dependencies.

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

On its own it serves no client. To play against it locally, put something in front that serves `public/` and proxies `/api/` and `/events/` to it, which is exactly what the `frontend` container does.

## Structure

Everything is in one file, top to bottom:

| Part | What it is |
| --- | --- |
| Constants | `MIN_PLAYERS`, `MAX_PLAYERS`, `MAX_HP`, `DAMAGE`, `SHOT_COOLDOWN_MS`, `COUNTDOWN_MS`, `POLL_WAIT_MS`, `POLL_EXPIRY_MS`, `MAX_BODY_BYTES` (1 MB), `MAX_MOTION_SAMPLES`, `GALLERY_FIELDS` |
| `Player` (dataclass) | id, name, gallery, hp, wins, alive, last shot time |
| `Room` | The game rules: a line-by-line port of `server/game.js`. See [Game rules](game-rules.md). |
| `Poller` (dataclass) | One polling session: message queue, last-seen time, the pending poll's future, and its `Session` |
| Global dicts | `rooms` (code → Room), `connections` (player id → Session), `pollers` (token → Poller), `sse_clients` (room code → set of queues) |
| `clean_*` helpers | Input sanitising for room codes, names, player ids, galleries (including the optional `reid` field) and motion samples |
| `broadcast_*`, `process_hit` | Fan-out of `state`, `roster`, SSE events and hit messages |
| `Session` | One connected phone: handles `join`, `shoot`, `scan`, `motion`, `start`, and cleans up on `close()` |
| `api_*`, `events`, `health` | HTTP handlers |
| `sweep_pollers` | Background task: every 5 s, closes sessions not seen for 30 s |
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

## Differences from the Node server

The two are meant to be equivalent; these are the known differences:

| | Python | Node |
| --- | --- | --- |
| `COUNTDOWN_MS` | 5000 | 3000 — an unintended divergence; see [Game rules](game-rules.md#constants) |
| Session sweep interval | 5 s | 10 s |
| Oversized body | `413` (checked from `Content-Length`) | `400` (counted while reading) |
| Second poll on same session | Replaces the waiter | Answers the first with `[]` |
| Body size limit | `MAX_BODY_BYTES` (1 MB), enforced by aiohttp's `client_max_size` | `MAX_BODY_BYTES` (1 MB), counted while reading |
| Health check at `/` | Yes | No (`/` serves the client) |

The automated tests run against the Node server only. When changing behaviour here, mirror it in `server/` and check the Node tests still describe it. See [Contributing](../development/contributing.md#keep-both-backends-in-sync).
