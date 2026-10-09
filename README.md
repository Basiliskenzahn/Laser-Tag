# Laser Tag

Laser tag that runs entirely on phones. No vests, no guns, no extra hardware. Point your phone's camera at your opponent, hit **FIRE**, and the phone works out whether the crosshair was on them.

Built during a 42-hour hackathon.

## How it works

- **The phone camera is the gun.** A crosshair sits in the middle of the live camera view.
- **Hitboxes come from image recognition.** Each phone runs a person detector ([MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector) EfficientDet-Lite0) on every camera frame, in the browser. Each person it finds gets a body hitbox, plus a head hitbox in the top-centre of the body box.
- **Shooting.** When you fire, the phone checks whether the crosshair is inside a hitbox. A body hit does 20 damage and a headshot does 50, starting from 100 HP.
- **Game server.** A small Node.js server keeps the two phones in sync over WebSockets. It handles the room, countdown, health, knockouts and rematches.

The current version is a demo for **two players**. Anyone the camera sees counts as the opponent, so keep bystanders out of the shot.

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

**Playing on phones (same Wi-Fi):** open the `https://` address on both phones. They'll warn that the certificate isn't trusted, because the server makes its own. Continue anyway: on iPhone, tap *Show Details → visit this website*; on Android, tap *Advanced → Proceed*. Enter a name and the same room code on both phones, then allow camera access.

**If the Wi-Fi blocks phones from reaching each other, or iPhone has trouble with the certificate:** run an HTTPS tunnel and open its URL on both phones instead:

```bash
brew install cloudflared            # once
cloudflared tunnel --url http://localhost:3000
```

**Testing on a laptop:** `http://localhost:3000` works with the webcam (browsers allow camera access on localhost). Press space to fire. Add `?debug` to the URL to show detector FPS and inference time.

### Running it with Docker

Docker splits the app into two containers instead of one process:

- **`backend`** - just the realtime game server (`server/ws-server.js`), plain HTTP/WS, reachable only from inside the Docker network.
- **`frontend`** - nginx serving the static client and reverse-proxying `/ws` to `backend`. It also terminates TLS (self-signed, generated on first start), so phones only ever talk to this one HTTPS origin - `app.js`'s same-origin WebSocket URL needs no change, and there's no mixed-content/second-certificate problem for phones to click through.

```bash
docker compose up --build
```

This publishes the same two ports `npm start` would: `http://localhost:3000` and `https://localhost:3443` (both now served by the `frontend` container). A named volume keeps the self-signed cert across restarts so phones don't have to re-accept it every time.

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
  index.html      Join screen and game screen
  app.js          Camera, render loop, HUD, shooting, networking
  detector.js     MediaPipe person detection and hitbox maths
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

- **Hitboxes are rectangles,** so the gap between outstretched arms counts as a hit. MediaPipe's pose landmarker would give body-shaped hitboxes and a precise head position.
- **Players aren't identified.** For more than two players, tell people apart by shirt colour or printed markers.
- **The shooter's phone decides whether a shot hit,** and the server trusts it. That's fine for a demo, but it's open to cheating.
- **Phones can't vibrate on iOS.** Safari doesn't support `navigator.vibrate`, so iPhones only get the red flash and sound when hit.

## Team

- David Wermuth ([@Basiliskenzahn](https://github.com/Basiliskenzahn))

## License

[MIT](LICENSE). The EfficientDet-Lite0 model is from Google MediaPipe and is licensed under Apache 2.0.
