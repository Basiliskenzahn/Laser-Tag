# Laser Tag

Laser tag that runs entirely on phones. No vests, no guns, no extra hardware. Point your phone's camera at an opponent, pull the trigger, and the game works out whether you hit.

Built during a 42-hour hackathon.

## Idea

- **Gun = phone camera.** A crosshair sits in the middle of the live camera view. Tap to shoot.
- **Hit detection.** When you shoot, the frame is checked to see whether a player is under the crosshair, and which player it is.
- **Game state.** A small realtime server tracks lobbies, players, health, score, and the round timer, and pushes updates to every phone.

## Proposed architecture

| Part | Choice | Why |
| --- | --- | --- |
| Client | Web app (PWA) | Works on iOS and Android with no app-store install. Camera access via `getUserMedia`. |
| Player detection | On-device ML (e.g. MediaPipe / TensorFlow.js person detection) | Runs in the browser, no server round-trip per shot. |
| Player identification | Coloured shirts/armbands or printed markers (ArUco/QR) | Much more reliable to build in 42h than recognising faces. |
| Realtime backend | Node.js + WebSockets (e.g. Socket.IO) | Simple lobby and state sync. |
| Hosting | Any HTTPS host | Browsers only allow camera access over HTTPS. |

## Getting started

_TBD once the stack is scaffolded._

## Team

- David Wermuth ([@Basiliskenzahn](https://github.com/Basiliskenzahn))

## License

[MIT](LICENSE)
