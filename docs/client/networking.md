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
conn.send(msg);               // queue a JSON message to the server
conn.close({ notify: true }); // stop; notify = tell the server right away
```

Lifecycle:

1. `POST /api/connect` returns a session `token`. `onOpen()` is called.
2. A loop calls `GET /api/poll?token=…`. The server holds each request open for up to 20 s until it has messages, then returns them as a JSON array. Each message goes to `onMessage()`.
3. `send()` POSTs to `/api/send?token=…`. Sends are chained on a promise, so they go out **one at a time, in order**.
4. Any failure (network error, non-2xx status, or a redirect such as an expired SSO login) closes the connection and calls `onClose()`. A `410` means the server has forgotten the session.
5. `close({notify: true})` sends `/api/disconnect` with `navigator.sendBeacon` (falling back to `fetch` with `keepalive`), so leaving works even while the page unloads.

## Reconnecting

`connect()` in `app.js` handles drops:

- On close, it shows *"Connection lost. Reconnecting…"* and opens a new connection after 1.5 s.
- After two failed attempts in a row that never opened, the message changes to *"Can't connect to the game server…"*.
- Each new connection sends `join` again with `playerId` set to the id from the last `welcome`. If the server still has that player (it keeps them for 30 s without polls), the phone **takes over the same player**: same HP, same scan, same place in a running round.
- If the player has expired and a round is running, the join is rejected with *"Lobby is already running."* and the phone returns to the join screen.

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

The server relays each phone's samples to **every other player in the room** as `{type: 'motion', from: <player id>, s: [...]}`; it never echoes them back to the sender and keeps no history of its own. `onRemoteMotion()` merges arriving samples into a per-player series sorted by time and trims it to the last 12 s.

Samples are capped at 32 per message (`MAX_MOTION_SAMPLES`, about 3 s at 10 Hz) and sanitised to finite, non-negative numbers on both servers, since they come straight from a client. A phone with motion disabled, or one that never got motion permission, simply sends nothing.

## Server-Sent Events

On entering the game screen the client opens `EventSource('/events/<room>')` and closes it on returning to the lobby. The stream carries `health` and `death` events for the whole room. Currently the client only logs them in debug mode; HP shown in the HUD comes from `state` messages. The stream is there for features that need a room-wide event feed, such as a kill feed or spectator view.
