# Python backend

The Python backend (used in Docker and production) is an [aiohttp](https://docs.aiohttp.org/) application with no other dependencies, split into four modules:

- `backend/models.py` - `Player` and `Room`: pure game rules, no networking.
- `backend/sanitize.py` - cleaning every value that comes from the client (room codes, names, galleries) before it touches `models.py`.
- `backend/transport.py` - the long-polling `Poller`, per-phone `Session`, the broadcast helpers, and the room/connection registries.
- `backend/app.py` - the entrypoint: the six route handlers, `create_app()`, and `python -m backend.app`. This is the only module `backend/Dockerfile`'s `CMD` launches.

It serves only `/api/*` and a health check at `/`. Static files and TLS are handled by nginx in front of it (see [Docker setup](../operations/docker.md)).

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

`backend/requirements.txt` pins `aiohttp==3.13.5`, which is the version the test suite runs
against. It used to pin `3.10.11` while the suite ran against whatever was installed, and that
gap mattered more now than it did then: the `413` behaviour is `client_max_size`'s alone, so
exactly where it rejects a body is the only thing deciding it. The pin and the tested version
have to be the same one. `docs/operations/docker.md` repeats this version and needs updating with
it.

On its own it serves no client. To play against it locally, put something in front that serves `frontend/public/` and proxies `/api/` to it, which is exactly what the `frontend` container does.

## Structure

| Part | Module | What it is |
| --- | --- | --- |
| Constants | `models.py` | `MIN_PLAYERS`, `MAX_PLAYERS`, `MAX_HP`, `DAMAGE`, `SHOT_COOLDOWN_MS`, `SHOT_COOLDOWN_SLACK_MS`, `COUNTDOWN_MS`, `CLONE_SUFFIX` |
| Constants | `transport.py`/`sanitize.py` | `POLL_WAIT_MS`, `POLL_EXPIRY_MS`, `SWEEP_INTERVAL_S`, `MAX_QUEUED_MOTION`, `MAX_QUEUED_MESSAGES`, `MAX_BODY_BYTES` (1 MB), `GALLERY_FIELDS`, `MAX_GALLERY_SAMPLES`, `MAX_MOTION_SAMPLES`, `MAX_MOTION_ACTIVITY` |
| `Player` (dataclass) | `models.py` | id, name, gallery, hp, wins, alive, forfeited, last shot time, gallery revision, round stats, time of going out |
| `RoundStats` (dataclass) | `models.py` | One player's kills, damage, shots, hits and headshots this round |
| `Room` | `models.py` | The game rules: originally a line-by-line port of the now-archived `deprecated/server/game.js`. See [Game rules](game-rules.md). |
| `Poller` (dataclass) | `transport.py` | One polling session: its token, a capped message queue, last-seen time, a future per parked poll, an eviction reason, and its `Session` |
| Global dicts | `transport.py` | `rooms` (code → Room), `connections` (player id → Session), `pollers` (token → Poller) |
| `clean_*` helpers | `sanitize.py` | Input sanitising for room codes, names, player ids, galleries (including the optional `reid` field) and motion samples |
| `broadcast_*`, `roster_for`, `process_hit` | `transport.py` | Fan-out of `state`, `roster` and hit messages. `roster_for()` is the per-connection roster [delta](protocol.md#the-roster-delta) |
| `Session` | `transport.py` | One connected phone: handles `join`, `scan`, `clearScan`, `motion`, `start`, and cleans up on `close()` - with `forfeit=True` for a deliberate leave. Shots arrive via `POST /api/hit` instead. Writes require `is_seated` - holding a room is not enough, the session must still *be* a player in it. |
| `evict`, `displace`, `poller_for` | `transport.py` | Ending one conversation without touching the room: marks a mailbox, drops its queue and delivery record, and wakes its parked poll so the phone is told `410`. See [Seat handover](protocol.md#seat-handover) |
| `api_*`, `health`, `create_app` | `app.py` | HTTP handlers and app assembly - the entrypoint |
| `sweep_once` / `sweep_pollers` | `transport.py` | One reaping pass, and the loop that runs it every 5 s: closes sessions not seen for 30 s |

## How a request flows

1. `POST /api/connect` creates a `Poller` with a new `Session`. The session's `sender` appends to the poller's queue and wakes a waiting poll.
2. `POST /api/send` parses the body and hands it to `Session.receive()`.
3. `Session.receive()` mutates the `Room` and calls `broadcast_state()` / `broadcast_roster()`, which push onto each connected phone's queue. `broadcast_state()` sends one shared snapshot via `send_to()` for every player in the room; `broadcast_roster()` walks `connections` instead and builds a per-phone payload with `roster_for()`, because the roster is a delta and a debug clone has no connection of its own. Neither loop waits on anything: a send is a list append plus waking a parked poll.
4. `GET /api/poll` returns the queue right away, or waits up to 20 s on a future that the sender resolves.


## Countdown timer

`broadcast_state()` cancels any pending timer for the room and, if the room is in `countdown`, schedules one more broadcast for 10 ms after the countdown ends. That broadcast is what flips all phones to *playing* at once.

The timer task takes itself out of `room.start_timer` the moment it stops sleeping, before it broadcasts anything. That is what keeps the cancel safe: a timer is only ever reachable for cancellation while it is still asleep, so no concurrent `broadcast_state()` can kill it part way through the player loop and leave the remaining phones on `countdown` forever. The handle used to stay in the slot for the whole of the timer's own broadcast, which was harmless only because nothing in the send path suspends — `Poller.push` is a list append — so there was no point at which the cancellation could land.

`cancel_room_timers()` cancels any outstanding ones at shutdown; these are the only tasks the process creates besides the reaper.

## State and scaling

All state is in process memory. Restarting the container ends every game and drops every scan. It runs as a single process, so it can't be scaled horizontally without moving state to shared storage.

## Behaviour worth knowing

- Session sweep interval: every 5 s, a session with no activity for 30 s is dropped. A pass that
  raises is logged and the loop continues; one escaping exception used to stop every future sweep
  for the life of the process, which leaked a seat per disconnected phone and a room per
  abandoned lobby, silently (the task is only awaited at shutdown).
- Unregistering a poll token and closing the session behind it always happen together, in
  `sweep_once()` and `api_disconnect()` and nowhere else. Anything else that wants to end a
  conversation early calls `evict()`, which leaves the reaper to take the player out of the room -
  so an eviction can never strand a seated player with nothing left to reap them.
- Body size limit (`MAX_BODY_BYTES`, 1 MB) is enforced in one place: aiohttp's `client_max_size`.
  It rejects *at* the limit, and a chunked body - which declares no `Content-Length` at all - while
  reading it; `api_send` catches both as `HTTPRequestEntityTooLarge` and answers the same JSON
  `413` as every other error. There were two enforcers until this branch, and having two is what
  produced the bug they were guarding: they disagreed about the boundary.
- The client is expected to hold only one `/api/poll` open per session, but two are handled: each
  parked poll gets its own future and all of them are woken.
- Each mailbox is capped (`MAX_QUEUED_MESSAGES`). A phone that stops draining
  it sheds superseded `state` snapshots first, and is evicted
  rather than trimmed once only messages that cannot be dropped silently are left. Motion and
  state alone can never evict anybody. See [the roster delta](protocol.md#the-roster-delta) for why
  a `roster` is never among what is dropped.
- `/` is a health check, not the client - nginx serves the client's static files.

## Tests

`backend/test_models.py` and `backend/test_protocol.py` are a from-scratch port of the archived
Node suites (`deprecated/server/game.test.js`, `deprecated/server/realtime.test.js`) against this
backend - no new dependency, since `unittest` is stdlib and `aiohttp.test_utils` ships with
`aiohttp`, which is already required. `backend/test_transport.py` covers what HTTP cannot reach:
the reaper (its eviction, the fan-out it triggers, what a parked poll sees, and a `close()` that
raises), the mailbox caps, the countdown timer, and a session holding a room it is no longer a
player in. See [Testing](../development/testing.md) for what they cover and how to run them.

Both `test_protocol.py` and `test_transport.py` patch `models.COUNTDOWN_MS` down to 200 ms for the
cases that play a round. `Room.start()` reads the module global when it is called, so nothing had
to be made injectable - and without it the suite spent about 23 of its 31 seconds asleep, which is
a suite people skip. Anything asserting that the room *passed through* `countdown` has to ask the
message history rather than the newest scoreboard (`saw_status()`), because 200 ms is short enough
that the newest one is already `playing`.

The same trick covers the shot cooldown: the one protocol test that posts two shots in a row
patches `SHOT_COOLDOWN_MS` and `SHOT_COOLDOWN_SLACK_MS` to `0` rather than sleeping 290 ms through
the real one. What the cooldown is actually worth is asserted in `test_models.py`, over the fake
clock, where it costs nothing.

Note for anyone adding a test that looks a room up in `transport.rooms`: `clean_room_code` caps a
code at 16 characters, so the key is the *cleaned* code, not whatever the test passed as `room`.
