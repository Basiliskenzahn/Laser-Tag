# API and protocol reference

The [Python backend](python-backend.md) speaks this protocol. Behind nginx, the paths are the same; nginx just forwards `/api/` and `/events/` to it.

All bodies are JSON. Responses carry `Cache-Control: no-store`.

## HTTP endpoints

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `POST` | `/api/connect` | — | `200 {"token": "<uuid>"}` |
| `POST` | `/api/send?token=T` | One [client message](#client--server-messages) | `204` |
| `GET` | `/api/poll?token=T` | — | `200 [ …server messages ]` |
| `POST` | `/api/disconnect?token=T` | — | `204` |
| `POST` | `/api/hit` | [Hit request](#post-apihit) | `200` result, or `400`/`404` with `{ok: false, error}` |
| `GET` | `/events/<room>` | — | `text/event-stream` |
| `GET` | `/` | — | `laser-tag python backend` (health check) |

### Sessions and long polling

`/api/connect` creates a session and returns its token. The token identifies one *connection*, not a player; the player id arrives later in `welcome`.

`/api/poll` returns every queued message for the session as a JSON array. If nothing is queued it holds the request open until a message arrives or **20 s** pass (then returns `[]`). The 20 s stays under the 30 s upstream timeout common in reverse proxies. Only one poll is held per session; a second one replaces the first poll's waiter, which never resolves on its own.

A session that hasn't polled or sent for **30 s** is closed, and its player leaves the room. The server sweeps for these every 5 s.

Errors:

| Status | When | Client should |
| --- | --- | --- |
| `410 {"error": "Unknown session"}` | Unknown or expired token | Reconnect with a new `/api/connect` |
| `400` | Body isn't valid JSON | Fix the request |
| `413` | Body over `MAX_BODY_BYTES` (1 MB) | Send less |

### `POST /api/hit`

```json
{ "room": "demo", "shooterId": "<player id>", "targetId": "<player id>", "zone": "body" }
```

`room` is optional; without it the server finds the room containing `shooterId`. On success:

```json
{ "ok": true, "victimId": "…", "damage": 20, "zone": "body", "ko": false, "hp": 80, "alive": true }
```

On failure: `{ "ok": false, "error": "Cooldown" }` with status `400`, or `404` if neither room nor shooter is found. Error strings are listed under [`shoot()`](game-rules.md#shootshooterid-targetid-zone).

A successful hit sends `hitConfirmed` to the shooter and `gotHit` to the victim (both via their poll loop), a `health` SSE event (and `death` on a knockout), and a fresh `state` to the room. This is the **only** way a hit reaches the server - there is no client → server `shoot` message; see [Streamlining](../streamlining.md) for why one briefly existed in the protocol and why it was removed.

### `GET /events/<room>` (Server-Sent Events)

Streams room-wide events. It starts with a `: connected` comment, then:

```
event: health
data: {"type":"health","room":"demo","shooterId":"…","targetId":"…","zone":"head","damage":50,"hp":50,"alive":true}

event: death
data: {"type":"death","room":"demo","playerId":"…","killerId":"…"}
```

`death` follows `health` when a hit knocks a player out. No authentication: anyone who knows a room code can listen.

## Client → server messages

Sent with `POST /api/send`.

### `join`

```json
{ "type": "join", "name": "Alice", "room": "demo", "playerId": "…", "gallery": [ … ], "debug": false }
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | No | Trimmed, max 20 characters, default `Player` |
| `room` | No | Lower-cased; only `a-z`, `0-9` and `-` kept; max 16; default `demo`. A missing room is created. |
| `playerId` | No | Resume as this player if they're still in the room. 8–80 characters of `A-Z a-z 0-9 : -`. |
| `gallery` | No | The player's scan, if they already have one. See [Gallery format](#gallery-format). |
| `debug` | No | `true` also adds a [debug clone](game-rules.md#debug-clones) |

Only the first `join` per session counts. Replies: `welcome`, then `state` and `roster` to everyone in the room; or `error` (*"Lobby is already running."*, *"Room is full"*). The joiner's own `roster` is always the **complete** one, including when it is a resume — see [The roster delta](#the-roster-delta).

### `scan`

```json
{ "type": "scan", "targetId": "<player id>", "gallery": [ … ] }
```

Saves a scan for any player in the room. Replies `scanSaved` to the sender, then `roster` and `state` to everyone; or `error`. Only the scanned player's gallery travels, not the whole room's — see [The roster delta](#the-roster-delta).

### `start`

```json
{ "type": "start" }
```

Starts a round. Replies `state` to everyone (status `countdown`), or `error`.

### `motion`

```json
{ "type": "motion", "s": [[1739812345600, 1.82], [1739812345700, 0.21]] }
```

This phone's own motion activity, for [motion-based identity confirmation](../client/identification.md#motion-confirmation-motion). Each entry is `[t, v]`: a `Date.now()` timestamp at the end of a 100 ms bin, and the RMS of the phone's linear acceleration over that bin in m/s².

The server **relays** it to every other player in the room as a [`motion`](#server--client-messages) message and keeps nothing. It is never echoed back to the sender. Cleaning (`cleanMotionSamples` / `clean_motion_samples`): at most `MAX_MOTION_SAMPLES` (32) entries per message, each a pair of finite numbers with `v >= 0`, `t` truncated to an integer and `v` rounded to 2 decimals. An empty result is dropped, not relayed.

There's no reply, and no error if the room has nobody else in it.

## Server → client messages

Delivered through `/api/poll`.

| Type | Fields | Sent to | When |
| --- | --- | --- | --- |
| `welcome` | `id` | Joiner | Join succeeded. `id` is your player id. |
| `error` | `message` | Sender | A join, scan or start was refused |
| `state` | `state` (below) | Everyone in the room | Any change, and when a countdown ends |
| `roster` | `players: [{id, name, gallery?}]` | Everyone in the room, each their own [delta](#the-roster-delta) | Joins, leaves, scans |
| `motion` | `from` (sender's player id), `s: [[t, v], …]` | Everyone in the room **except** the sender | A phone sent a `motion` message (about every 500 ms per phone) |
| `scanSaved` | `targetId` | Scanner | Scan stored |
| `hitConfirmed` | `zone`, `damage`, `ko` | Shooter | Your shot landed |
| `gotHit` | `zone`, `damage`, `ko` | Victim | You were hit |

### The roster delta

Every phone matches locally against everyone's signatures, so every gallery genuinely has to reach every phone ([Identification](../client/identification.md)). What does *not* have to happen is sending all of them to everyone again whenever one of them changes.

So `roster` is a per-connection delta:

- **Membership is always complete.** Every player in the room appears in every `roster` message, with `id` and `name`. One message is enough to tell who is in the room and who left.
- **`gallery` is conditional.** It is attached only when that player's scan differs from the one this connection was last handed. An entry with **no `gallery` key** means *keep the one you already have*.
- An entry **with** `gallery: []` is a real value — a player nobody has scanned yet — and is not the same thing as a withheld gallery.

```json
{ "type": "roster", "players": [
  { "id": "a", "name": "Alice" },
  { "id": "b", "name": "Bob", "gallery": [ … ] }
] }
```

Alice's scan is unchanged; Bob was just scanned.

The server tracks what it has sent per *session* (`Session.sent_gallery_revs`, keyed by the `gallery_rev` counter on each `Player`), not per player. That is what makes this safe without any version negotiation or client acknowledgement: a session is one conversation with one phone, and every way of losing a message — a dropped poll, a `410`, a reload, a reconnect — ends that conversation. The phone then opens a new session, which has an empty record and is therefore sent **the whole roster in full**. There is no state a phone can reach where it believes it holds a gallery the server never delivered, and deltas cannot arrive out of order because the server only ever withholds what it has already put on that same wire.

A clone's entry follows the owner it borrows its gallery from (`Room.mirrored_gallery_rev`), so rescanning the owner re-sends the clone's entry too.

Client side: `mergeRoster()` in `frontend/public/roster.js`.

#### Why: the cost it replaces

A full gallery is ~190 KB of JSON. Sending the whole roster to everyone meant **N × N** copies of that per scan. Measured against the real server with 24-sample galleries, for one scan in a room of N:

| Players | Was (egress / scan) | Now | What the scanning phone waits for |
| --- | --- | --- | --- |
| 2 | 865 KB | 382 KB | 433 KB → 191 KB |
| 4 | 3459 KB | 764 KB | 865 KB → 191 KB |
| 6 | 7782 KB | 1148 KB | 1297 KB → 191 KB |
| 8 | 13833 KB | 1533 KB | 1729 KB → 192 KB |

Egress is now linear in the room size instead of quadratic, and what the *scanner* waits for is flat: one gallery, whatever the room size. That last column was the user-visible bug — `scanSaved` shares a poll response with the roster, so the scanning phone had to pull down its whole share of the fan-out before it could see its own scan being confirmed.

(Part of the drop is unrelated to the delta: poll responses are now serialised without `json.dumps`' default whitespace, which was ~13% of every body. See `compact_dumps` in `app.py`.)

### State snapshot

```json
{
  "code": "demo",
  "status": "playing",
  "startsInMs": null,
  "winner": null,
  "maxHp": 100,
  "minPlayers": 2,
  "maxPlayers": 8,
  "players": [
    { "id": "…", "name": "Alice", "hp": 60, "wins": 1, "alive": true }
  ]
}
```

| Field | Notes |
| --- | --- |
| `status` | `waiting`, `countdown`, `playing` or `over` |
| `startsInMs` | Milliseconds until play starts during `countdown`, else `null` |
| `winner` | Player id of the last round's winner, or `null` |

## Gallery format

A gallery is an array of samples, one per viewing angle. The server cleans it defensively:

- at most **24** samples;
- each field is truncated to its maximum length, and non-numeric entries are dropped;
- unknown fields are discarded.

| Field | Max length | Required | Produced by the client as |
| --- | --- | --- | --- |
| `hist` | 64 | Yes (kept even if empty) | 64 |
| `grid` | 256 | Yes (kept even if empty) | 192 |
| `lower` | 64 | No | 64 |
| `shape` | 8 | No | 2 |
| `embed` | 512 | No | 256 |
| `reid` | 512 | No | 512 |

Field meanings: [Identification → Signatures](../client/identification.md#signatures). A new signature field must be added to `GALLERY_FIELDS` in **both** servers, or it will be silently dropped. `reid` is the [person re-identification embedding](../client/identification.md#the-re-identification-embedding-reidjs); it's optional in the format because a phone where the ONNX model failed to load still produces a usable colour-only gallery.

`shape` is the one field whose *magnitude* matters: it holds raw box proportions (aspect ~0.6–7) rather than a unit vector, because it is compared as a log ratio rather than by cosine similarity. `clean_vector` only requires finite floats, so that passes through unchanged — but a sanitiser that ever starts clamping values to [-1, 1] would silently break it.

**Watch the size.** `embed` and `reid` are rounded to 4 decimals by the client; the colour fields are sent at full float precision, which makes them the expensive half per number even though they are the smaller half per count. A full 24-sample gallery is roughly **150 KB** of JSON with colour features only and **190–300 KB** with both embeddings, depending on how many digits the colour features come out with — measured at **190 KB** with everything rounded to 4 decimals, which is the floor. `MAX_BODY_BYTES` is 1 MB on both servers, and nginx allows 2 MB on `/api/`, so there's comfortable headroom — but if you add a field or more samples, round the values (as `compactEmbedding` and `reid.js`'s `normalize` do) and re-check both limits.

Rounding the **colour** fields the way the embeddings already are would be the single biggest saving still on the table, and unlike dropping a field it costs no matching accuracy that 4 decimals of a normalised histogram bin can carry. It belongs with whoever owns the scan capture, not here.

`embed` is the other obvious candidate, and it is **deliberately still sent**: ~22% of a gallery that the normal path never reads, because `identify.js` lets re-identification decide alone whenever every enrolled player has a `reid` vector. But it is the fallback for a phone whose OSNet model failed to load, and that is a property of the *receiving* phone, which the scanning phone cannot know — and `reid` loads asynchronously, after `join`, so a phone cannot usefully declare it up front either. Dropping it would silently remove graceful degradation for exactly the phone that needs it. Left in on purpose; see [Identification](../client/identification.md#signatures).
