# Deployment info

Port 8080 (HTTP) will be exposed through the reverse proxy and is after deployment reachable here: https://22.hackathon.ethz.ch/

# Laser Tag

Laser tag that runs entirely on phones. No vests, no guns, no extra hardware. Point your phone's camera at your opponent, hit **FIRE**, and the phone works out whether the crosshair was on them - including *who* it was, from a pre-match scan, an on-device appearance/re-identification model, and a phone-motion cross-check.

Built during a 42-hour hackathon.

**Full documentation lives in [`docs/`](docs/README.md)** - architecture, how identification actually works (colour signature → learned re-identification embedding → motion confirmation), the wire protocol, configuration/tuning, and known structural issues worth revisiting ([`docs/streamlining.md`](docs/streamlining.md)). This file is just enough to get it running.

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

**If the Wi-Fi blocks phones from reaching each other:** run an HTTPS tunnel and open its URL on every phone instead:

```bash
brew install cloudflared            # once
cloudflared tunnel --url http://localhost:8080
```

**Testing on a laptop:** `http://localhost:8080` works with the webcam (browsers allow camera access on localhost). Press space to fire. Add `?debug` to the URL to show detector FPS, inference time and how many tracked people are currently identified. See [Debug mode](docs/development/debug-mode.md) and [Configuration](docs/development/configuration.md) for every other `?` flag, including `?motion=on`/`?motion=strict`.

Run both test suites in Docker:

```bash
docker compose run --rm tests           # JS (client)
docker compose run --rm backend-tests   # Python (backend)
```

To run them without Docker (Node 20+, Python 3.12/3.13, `pip install -r backend/requirements.txt` first), see [Testing](docs/development/testing.md).

Everything else - the two-container Docker setup, the protocol, project layout, and what each module owns - is in [`docs/`](docs/README.md): start with [Getting started](docs/getting-started.md) and [Architecture](docs/architecture.md).

## Team

- David Wermuth ([@Basiliskenzahn](https://github.com/Basiliskenzahn))

## License

[MIT](LICENSE). The EfficientDet-Lite0 model is from Google MediaPipe and is licensed under Apache 2.0. The OSNet re-identification weights are from [Torchreid](https://github.com/KaiyangZhou/deep-person-reid) by Kaiyang Zhou (MIT, [model files](https://huggingface.co/kaiyangzhou/osnet)), converted to ONNX.
