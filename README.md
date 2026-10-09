# Laser Tag

Laser tag that runs entirely on phones. No vests, no guns, no extra hardware. Point your phone's camera at your opponent, hit **FIRE**, and the phone works out whether the crosshair was on them.

Built during a 42-hour hackathon.

## How it works

- **The phone camera is the gun.** A crosshair sits in the middle of the live camera view.
- **Hitboxes come from image recognition.** Each phone runs a person detector ([MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector) EfficientDet-Lite0) on every camera frame, in the browser. Each person it finds gets a body hitbox, plus a head hitbox in the top-centre of the body box.
- **Players are identified, not just detected.** Before the match, everyone is scanned from a few angles; during the match each tracked body is matched against those scans to figure out *who* it is. See [Player identification](#player-identification) below.
- **Shooting.** When you fire, the phone checks whether the crosshair is on an identified player. A body hit does 20 damage and a headshot does 50, starting from 100 HP.
- **Game server.** A small Node.js server keeps every phone in a room in sync over WebSockets. It handles the room, countdown, health, knockouts (last one standing wins) and starting the next round.

The game supports up to 8 players per room (`MAX_PLAYERS` in `server/game.js`).

## Player identification

Plain person detection only answers "is there a person here?" - with more than two players that's not enough to know who to damage. This is solved in two phases:

**1. Scan, before the match.** After entering a name and room code, each phone scans its own player: the phone is handed to someone else, who points its camera at the player while they turn through four poses (front, right, back, left). Each pose is captured as an appearance *signature* - a torso colour histogram plus a coarse colour/shape grid over the body box, both just canvas pixel reads, no extra model to download. That phone then joins the room carrying its player's signatures; the server fans everyone's signatures out to every other phone in the room (as a `roster` message, kept separate from the frequent HP/score updates so it isn't resent on every shot).

**2. Identify, during the match.** Each frame, every detected body is matched against every other player's four signatures, and the best-matching *angle* wins - which is what makes the match tolerant of whatever side the camera currently sees someone from. A match only counts if it clears both an absolute similarity threshold and a margin over the runner-up; otherwise the body is left "unknown" rather than guessed at. Running that match on every box of every frame would be wasteful, so a lightweight IOU tracker first threads boxes into tracks across frames, and only re-runs the (slightly) more expensive matching per track every ~0.4s (plus the first few frames of a brand new track, to identify it quickly) - identity rides along with the track in between. A switch away from an established identity also needs a few consecutive agreeing checks (hysteresis), so one ambiguous frame can't flip who you're credited with shooting.

This is deliberately built from cheap, model-free signals so it runs smoothly on a phone browser alongside the person detector. `public/identify.js` isolates it behind `extractSignature()` / `matchGallery()`, so a learned person re-identification embedding (e.g. a small MobileNet-based model in TensorFlow.js) could later replace or augment the colour/grid signature without touching the tracking or enrolment code around it.

## Running it

You need Node.js 20 or newer.

```bash
npm install
npm start
```

The server prints two kinds of address:

```
  Laptop:  http://localhost:3000
  Phones:  https://192.168.x.x:3443
```

**Playing on phones (same Wi-Fi):** open the `https://` address on every phone. They'll warn that the certificate isn't trusted, because the server makes its own. Continue anyway: on iPhone, tap *Show Details → visit this website*; on Android, tap *Advanced → Proceed*. Enter a name and the same room code, then allow camera access.

**Connection fallback:** phones talk to the server over a WebSocket when they can. Some networks block that: the hackathon's SSO gateway answers every WebSocket upgrade with 502, and iPhone Safari refuses WebSockets to a self-signed address even after you accept the warning. When the WebSocket can't connect, the app switches to HTTP long polling (`/api/connect`, `/api/send`, `/api/poll` in `server/realtime.js`), which gets through both.

**If the Wi-Fi blocks phones from reaching each other:** run an HTTPS tunnel and open its URL on every phone instead:

```bash
brew install cloudflared            # once
cloudflared tunnel --url http://localhost:3000
```

**Testing on a laptop:** `http://localhost:3000` works with the webcam (browsers allow camera access on localhost). Press space to fire. Add `?debug` to the URL to show detector FPS, inference time and how many tracked people are currently identified.

With just one laptop/webcam you can still exercise the identification pipeline: open two browser tabs (two different player names, same room code), scan each "player" by holding a photo or turning the webcam between tabs, then play - each tab's `?debug` overlay shows `N identified`.

### Running it with Docker

Docker splits the app into two containers instead of one process:

- **`backend`** - just the realtime game server (`server/ws-server.js`), plain HTTP/WS, reachable only from inside the Docker network.
- **`frontend`** - nginx serving the static client and reverse-proxying `/ws` to `backend`. It also terminates TLS (self-signed, generated on first start), so phones only ever talk to this one HTTPS origin - `app.js`'s same-origin WebSocket URL needs no change, and there's no mixed-content/second-certificate problem for phones to click through.

```bash
docker compose up --build
```

This publishes `http://localhost:8080` and `https://localhost:3443` (both served by the `frontend` container; nginx forwards `/ws` and `/api/` to the backend). A named volume keeps the self-signed cert across restarts so phones don't have to re-accept it every time.

For phones on the LAN, use the **host machine's** own LAN IP on port 3443 (e.g. `https://192.168.x.x:3443`) - look it up yourself (`ip addr` / `ipconfig`); nothing in the containers' logs gives you the host's address.

Without compose, build and run each image and connect them manually:

```bash
docker build -t laser-tag-backend -f backend/Dockerfile .
docker build -t laser-tag-frontend -f frontend/Dockerfile .
docker network create laser-tag
docker run --rm -d --network laser-tag --name backend laser-tag-backend
docker run --rm -p 3000:80 -p 3443:443 --network laser-tag laser-tag-frontend
```

## Project layout

```
server/
  index.js        Combined dev server (static files + game) for `npm start` - not used by Docker
  ws-server.js     Backend container's entrypoint: just the realtime game server
  realtime.js      WebSocket protocol + room/player bookkeeping, shared by both of the above
  game.js          Room logic (players, HP, countdown, knockouts); no networking
  game.test.js     Unit tests: npm test
public/
  index.html      Join screen, scan (enrolment) screen and game screen
  app.js          Camera, render loop, HUD, scanning, shooting, networking
  detector.js     MediaPipe person detection and hitbox maths
  identify.js     Appearance signatures, gallery matching and the per-track identification state machine
  sound.js        Synthesised sound effects (Web Audio)
  models/         EfficientDet-Lite0 model, committed so the game works offline
backend/Dockerfile    Backend container: node server/ws-server.js
frontend/
  Dockerfile        Frontend container: nginx serving public/ + reverse-proxying /ws to backend
  nginx.conf        The static + reverse-proxy + TLS config above
  entrypoint.sh     Generates the self-signed cert on first start, then execs nginx
docker-compose.yml  `docker compose up --build` wires the two containers together
```

## Limitations and ideas for next steps

- **Hitboxes are rectangles,** so the gap between outstretched arms counts as a hit. MediaPipe's pose landmarker would give body-shaped hitboxes and a precise head position, and a proper torso region to sample for identification instead of the geometric approximation `identify.js` uses today.
- **Identification is colour/shape, not a learned embedding.** It's deliberately cheap (no extra model download) and works well when players' clothing differs, but two players in near-identical outfits will often come back "unknown" rather than misidentified - by design, since a wrong hit attribution is worse than a missed one. A small ReID embedding network would close that gap; see [Player identification](#player-identification).
- **The shooter's phone decides whether a shot hit** (both that it was a person, and who), and the server trusts it. That's fine for a demo, but it's open to cheating.
- **Enrolment needs a cooperative second phone/person** to hold the camera on you while you turn. A front-camera "turn in front of a mirror" mode would make solo enrolment possible.
- **Phones can't vibrate on iOS.** Safari doesn't support `navigator.vibrate`, so iPhones only get the red flash and sound when hit.

## Team

- David Wermuth ([@Basiliskenzahn](https://github.com/Basiliskenzahn))

## License

[MIT](LICENSE). The EfficientDet-Lite0 model is from Google MediaPipe and is licensed under Apache 2.0.
