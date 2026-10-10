# Client networking

The client talks to the server over three plain-HTTP channels. There are no WebSockets.

| Channel | Code | Used for |
| --- | --- | --- |
| Long polling | `frontend/public/transport.js` | Joining, scans, starting rounds, optional motion sharing; receiving `state`, `roster`, `motion`, `hitConfirmed`, `gotHit`, `error` |
| `POST /api/hit` | `postHit()` in `app.js` | Reporting a shot |
| Server-Sent Events | `openGameEvents()` in `app.js` | Room-wide `health` and `death` events during a round |

Message formats are in the [protocol reference](../server/protocol.md).

## `transport.js`: the polling connection

```js
const conn = openPolling({ onOpen, onMessage, onClose });
await conn.send(msg);         // queue a JSON message; true once the server has it, false if not
conn.close({ notify: true }); // stop; notify = tell the server right away
```

Lifecycle:

1. `POST /api/connect` returns a session `token`. `onOpen()` is called.
2. A loop calls `GET /api/poll?token=…`. The server holds each request open for up to 20 s until it has messages, then returns them as a JSON array. Each message goes to `onMessage()`.
3. `send()` POSTs to `/api/send?token=…`. Sends are chained on a promise, so they go out **one at a time, in order**.
4. A failure in the poll loop (network error, non-2xx status, or a redirect such as an expired SSO login) closes the connection and calls `onClose()`. A `410` means the server has forgotten the session.
5. `close({notify: true})` sends `/api/disconnect` with `navigator.sendBeacon` (falling back to `fetch` with `keepalive`), so leaving works even while the page unloads. Repeated calls say goodbye only once.

**Only the poll loop decides the connection is gone.** Two other things used to be able to, and both now stop at the transport:

- **A send that fails** is retried twice, 250 ms apart — a single transient error on the ~190 KB scan gallery POST is the case that matters. If it still cannot get the message out, `send()` resolves `false` and the connection is left alone. It never rejects, so the many fire-and-forget callers can keep ignoring the result. A caller that has told the player something worked must not: `saveCurrentScan()` reports a scan that never left the phone instead of saying *"Saved scan for …"* about it.
- **A message handler that throws** is caught around the `onMessage()` call and logged. Letting it reach the poll loop's `catch` closed the connection, which reconnected, which re-joined, which was sent the same message again — and since the connection had opened, nothing counted the failures, so one bad message hammered the server for as long as the page was open under a banner that only said *"Reconnecting…"*.

## The roster

`roster` is the one message that carries real weight — a player's appearance gallery is ~190 KB — so the server sends it as a **delta**, and `handleMessage()` in `net.js` folds it in with `mergeRoster()` from `roster.js`:

```js
state.roster = mergeRoster(state.roster, msg.players);
```

Membership always arrives complete, so the entries *are* the room: a player who left is simply absent. What is conditional is `gallery`, which is present only when that player's scan changed since this connection last heard about them. An entry without one means **keep the gallery you already have**; an entry with `gallery: []` means that player genuinely has no scan yet.

Nothing on the client has to detect a gap or ask for a resend. The server tracks what it put on *this connection's* wire, and every way of losing a message — a failed `fetch`, a non-2xx, a `410`, a reload — closes the connection, after which `connect()` re-joins on a new session and is sent the roster in full. The delta is therefore self-synchronising; see [the protocol reference](../server/protocol.md#the-roster-delta) for the server side and the measured before/after.

## Reconnecting

`connect()` in `net.js` handles drops:

- On close, it shows *"Connection lost. Reconnecting…"* and opens a new connection after 1.5 s.
- After two failed attempts in a row that never opened, the message changes to *"Can't connect to the game server…"*.
- Each new connection sends `join` again with `playerId` set to the id from the last `welcome`. If the server still has that player (it keeps them for 30 s without polls), the phone **takes over the same player**: same HP, same scan, same place in a running round. The takeover is a new session, so the roster it receives is the complete one — a reconnect cannot land on a stale or partial set of galleries.
- If the player has expired and a round is running, the join is rejected with *"Lobby is already running."* and the phone returns to the join screen.
- The last `state` snapshot is **kept**, not cleared. Everything that gates on it — the HUD, whether this phone may fire, what is under the crosshair — would otherwise blank out for the whole 1.5 s on every blip, and on a phone network that is often. `state.connected` is what says the snapshot is no longer live.

### Leaving, as opposed to dropping

`leaveRoom({notify})` is the one way out: it **cancels the pending reconnect**, closes the connection, nulls `state.conn` and stops the identity provider. The three paths that leave a room — `leaveLobby()`, `showJoinRejected()`, and the camera-failure path in `enterLobbyFromForm()` — all go through it, as does `pagehide`.

Cancelling matters because leaving deliberately keeps `name`/`room`/`resumePlayerId` so that a *blip* reconnects as the same player. A retry that outlived a leave therefore had everything `sendJoin()` needed, and would quietly put the player back in the room they had just left — a ghost nobody can scan or shoot, whose `welcome` then saved that room as the one to resume into on the next page load.

Two things know the connection is no longer live:

- `state.connected`, set in `onOpen`/`onClose`. `renderLobby()` reads it, because it is the only writer of the Launch button's `disabled` state: with the connection down, Launch would otherwise hand the player a 3 s countdown into a round the server never hears about, on a game screen with no way back out. `showConnectionProblem()` re-renders the lobby for that reason.
- the banner, on whichever screen is showing.

### Closing the tab

`net.js` listens for **`pagehide`** and calls `leaveRoom({notify: true})`, so the room drops the player at once instead of holding a phantom until the long poll times out. `pagehide` rather than `beforeunload`, which iOS Safari does not reliably fire — and deliberately *not* `visibilitychange`, because the page goes hidden every time the player glances at a notification and a round has to survive that. The server's poll timeout remains the backstop for a tab the OS kills outright.

## Resuming after a reload

When the server sends `welcome`, the client saves `{name, room, playerId, debug}` to `localStorage` as `activeLobby`. On page load, `resumeActiveLobby()` reads it and rejoins automatically with that `playerId`. This is what makes an accidental reload mid-game recoverable.

## Hits

Shots go to a dedicated endpoint rather than through the polling session:

```js
POST /api/hit
{ "room": "demo", "shooterId": "<my id>", "targetId": "<their id>", "zone": "head" }
```

The response isn't used for feedback. Confirmation arrives as `hitConfirmed` on the shooter's poll and `gotHit` on the victim's. Rejected shots are only logged in [debug mode](../development/debug-mode.md).

## Motion samples

Motion samples are sent by default. This channel is unused when the page is opened with `?motion=off`.

The polling session is also how phones share motion for [identity confirmation](identification.md#motion-confirmation-motion). Every 500 ms `flushMotion()` takes whatever new 100 ms bins the sensor has produced and sends them as one message:

```js
{ "type": "motion", "s": [[1739812345600, 1.82], [1739812345700, 0.21]] }
```

The server relays each phone's samples to **every other player in the room** as `{type: 'motion', from: <player id>, s: [...]}`; it never echoes them back to the sender and keeps no history of its own. The motion provider's remote-sample handler merges arriving samples into a per-player series sorted by time and trims it to the last 12 s.

Samples are capped at 32 per message (`MAX_MOTION_SAMPLES`, about 3 s at 10 Hz) and sanitised to finite, non-negative numbers on both servers, since they come straight from a client. A phone with motion disabled, or one that never got motion permission, simply sends nothing.

## Server-Sent Events

On entering the game screen the client opens `EventSource('/events/<room>')` and closes it on returning to the lobby. The stream carries `health` and `death` events for the whole room. Currently the client only logs them in debug mode; HP shown in the HUD comes from `state` messages. The stream is there for features that need a room-wide event feed, such as a kill feed or spectator view.
