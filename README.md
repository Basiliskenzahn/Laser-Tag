# Deployment info

Port 8080 (HTTP) will be exposed through the reverse proxy and is after deployment reachable here: https://22.hackathon.ethz.ch/

# Laser Tag

> Full documentation lives in [`docs/`](docs/README.md).

Laser tag that runs entirely on phones. No vests, no guns, no extra hardware. Point your phone's camera at your opponent, hit **FIRE**, and the phone works out whether the crosshair was on them.

Built during a 42-hour hackathon.

## How it works

- **The phone camera is the gun.** A crosshair sits in the middle of the live camera view.
- **Hitboxes come from image recognition.** Each phone runs a person detector ([MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector) EfficientDet-Lite0) on every camera frame, in the browser. Each person it finds gets a body hitbox, plus a head hitbox in the top-centre of the body box.
- **Players are identified, not just detected.** Before the match, everyone is scanned from a few angles; during the match each tracked body is matched against those scans to figure out *who* it is. See [Player identification](#player-identification) below.
- **Shooting.** When you fire, the phone checks whether the crosshair is on an identified player. A body hit does 20 damage and a headshot does 50, starting from 100 HP.
- **Game server.** The realtime backend keeps every phone in a room in sync over HTTP polling and SSE. It handles the room, countdown, health, knockouts (last one standing wins) and starting the next round.

The game supports up to 8 players per room (`MAX_PLAYERS` in `server/game.js`).

## Player identification

Plain person detection only answers "is there a person here?" - with more than two players that's not enough to know who to damage. This is solved in two phases:

**1. Scan, before the match.** After entering a name and room code, each phone scans its own player: the phone is handed to someone else, who points its camera at the player while they turn through four poses (front, right, back, left). Each pose is captured as an appearance *signature* - a torso colour histogram plus a coarse colour/shape grid over the body box, both just canvas pixel reads, no extra model to download. That phone then joins the room carrying its player's signatures; the server fans everyone's signatures out to every other phone in the room (as a `roster` message, kept separate from the frequent HP/score updates so it isn't resent on every shot).

**2. Identify, during the match.** Each frame, every detected body is matched against every other player's four signatures, and the best-matching *angle* wins - which is what makes the match tolerant of whatever side the camera currently sees someone from. A match only counts if it clears both an absolute similarity threshold and a margin over the runner-up; otherwise the body is left "unknown" rather than guessed at. Running that match on every box of every frame would be wasteful, so a lightweight IOU tracker first threads boxes into tracks across frames, and only re-runs the (slightly) more expensive matching per track every ~0.4s (plus the first few frames of a brand new track, to identify it quickly) - identity rides along with the track in between. A switch away from an established identity also needs a few consecutive agreeing checks (hysteresis), so one ambiguous frame can't flip who you're credited with shooting.

This is deliberately built from cheap, model-free signals so it runs smoothly on a phone browser alongside the person detector. `public/identify.js` isolates it behind `extractSignature()` / `matchGallery()`, so a learned person re-identification embedding (e.g. a small MobileNet-based model in TensorFlow.js) could later replace or augment the colour/grid signature without touching the tracking or enrolment code around it.

## Person re-identification (OSNet)

The colour features and generic MobileNet embedding over-classify: bystanders get labelled as players. Each scan sample and each tracked person now also gets an embedding from **OSNet x0.25** (`public/reid.js`, `public/models/osnet_x0_25_msmt17.onnx`, 0.9 MB), a network trained specifically for person re-identification. It comes from the Torchreid authors (MIT licence), trained on MSMT17, and was exported to ONNX. It runs in the browser with ONNX Runtime Web, in about 9 ms per person in desktop Chrome.

When both sides have that embedding, it alone decides the match (blending in the colour features only made it worse), with its own thresholds: accept at a similarity of 0.72 with a 0.03 margin over the runner-up. Closed-set mode no longer force-accepts the best match below those thresholds. Without the model (it failed to load, or an older scan), everything works as before.

Evaluation on Market-1501, people the model never saw, in 2,000 simulated games of 2-4 players with 20 bystanders each:

| | Players recognised at 1% / 5% / 10% bystander acceptance |
| --- | --- |
| Colour + MobileNet signature | 17.8% / 33.9% / 43.8% |
| OSNet x0.25 | 53.9% / 77.2% / 86.0% |

In the game's closed-set mode, per single check: before, every bystander was labelled as a player; now 7.6% are, while 82.8% of players are recognised and 0.5% are assigned to the wrong player. The tracker needs agreeing checks before naming someone, so per person it's lower still. Not yet tested on real phones; on a phone, inference will be slower than on desktop.

## Running it

You need Docker Desktop or Docker Engine with Compose. You do not need local Node.js,
Python, or `node_modules`; those live inside containers.

```bash
docker compose up --build
```

This publishes:

```
  Laptop:  http://localhost:8080
  Phones:  https://<your-lan-ip>:3443
```

**Playing on phones (same Wi-Fi):** open the `https://` address on every phone. They'll warn that the certificate isn't trusted, because the server makes its own. Continue anyway: on iPhone, tap *Show Details → visit this website*; on Android, tap *Advanced → Proceed*. Enter a name and the same room code, then allow camera access.

**Connection transport:** phones use HTTP long polling for room control/state (`/api/connect`, `/api/send`, `/api/poll`), POST hits to `/api/hit`, and listen for health/death events over SSE (`/events/<room>`). There is no WSS connection path.

**If the Wi-Fi blocks phones from reaching each other:** run an HTTPS tunnel and open its URL on every phone instead:

```bash
brew install cloudflared            # once
cloudflared tunnel --url http://localhost:8080
```

**Testing on a laptop:** `http://localhost:8080` works with the webcam (browsers allow camera access on localhost). Press space to fire. Add `?debug` to the URL to show detector FPS, inference time and how many tracked people are currently identified.

With just one laptop/webcam you can still exercise the identification pipeline: open two browser tabs (two different player names, same room code), scan each "player" by holding a photo or turning the webcam between tabs, then play - each tab's `?debug` overlay shows `N identified`.

Docker splits the app into two containers instead of one process:

- **`backend`** - the Python realtime game backend, plain HTTP, reachable only from inside the Docker network.
- **`frontend`** - nginx serving the static client and reverse-proxying `/api/` and `/events/` to `backend`. It also terminates TLS (self-signed, generated on first start), so phones only ever talk to this one HTTPS origin.

A named Docker volume keeps the self-signed cert across restarts so phones don't have to re-accept it every time.

For phones on the LAN, use the **host machine's** own LAN IP on port 3443 (e.g. `https://192.168.x.x:3443`) - look it up yourself (`ip addr` / `ipconfig`); nothing in the containers' logs gives you the host's address.

Run tests in Docker too:

```bash
docker compose run --rm tests
```

Without compose, build and run each image and connect them manually:

```bash
docker build -t laser-tag-backend -f backend/Dockerfile .
docker build -t laser-tag-frontend -f frontend/Dockerfile .
docker network create laser-tag
docker run --rm -d --network laser-tag --name backend laser-tag-backend
docker run --rm -p 8080:80 -p 3443:443 --network laser-tag laser-tag-frontend
```

## Project layout

```
server/
  index.js        Combined Node dev server kept for compatibility - not used by Docker
  realtime.js      HTTP polling/SSE protocol + room/player bookkeeping for local dev
  game.js          Room logic (players, HP, countdown, knockouts); no networking
  game.test.js     Unit tests: npm test
public/
  index.html      Join screen, scan (enrolment) screen and game screen
  app.js          Camera, render loop, HUD, scanning, shooting, networking
  detector.js     MediaPipe person detection and hitbox maths
  identify.js     Appearance signatures, gallery matching and the per-track identification state machine
  sound.js        Synthesised sound effects (Web Audio)
  models/         EfficientDet-Lite0 model, committed so the game works offline
backend/
  app.py            Python backend: polling, hit POST endpoint and SSE game events
  Dockerfile        Backend container: python -m backend.app
frontend/
  Dockerfile        Frontend container: nginx serving public/ + reverse-proxying /api/ and /events/
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

[MIT](LICENSE). The EfficientDet-Lite0 model is from Google MediaPipe and is licensed under Apache 2.0. The OSNet re-identification weights are from [Torchreid](https://github.com/KaiyangZhou/deep-person-reid) by Kaiyang Zhou (MIT, [model files](https://huggingface.co/kaiyangzhou/osnet)), converted to ONNX.
