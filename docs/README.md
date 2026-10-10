# Laser Tag documentation

Laser tag that runs entirely in phone browsers: the camera is the gun, on-device image recognition decides who you hit, and a small server keeps score.

## Start here

- [Getting started](getting-started.md): run it and connect phones
- [How to play](how-to-play.md): join, scan, shoot
- [Troubleshooting](troubleshooting.md): common problems and fixes
- [Architecture](architecture.md): how the parts fit together

## Client (`frontend/public/`)

- [App flow and screens](client/app-flow.md): join → lobby → scan → game, and which module owns each
- [Networking](client/networking.md): long polling, hit posts, motion sharing, SSE, reconnect and resume
- [Person detection and hitboxes](client/detection.md): MediaPipe models and `detector.js`
- [Scanning (enrolment)](client/scanning.md): how a player's appearance is recorded
- [Player identification](client/identification.md): signatures, matching and the tracker in `identify.js`, the re-identification model in `reid.js`, and motion confirmation in `motion/`
- [HUD, sound and feedback](client/feedback.md): what players see and hear

## Server

- [Game rules and room lifecycle](server/game-rules.md): HP, damage, countdown, winning
- [API and protocol reference](server/protocol.md): every endpoint and message
- [Python backend](server/python-backend.md): `backend/`, the only server implementation - used in Docker and production, and in local dev

## Operations

- [Docker setup](operations/docker.md): containers, nginx, TLS certificates
- [Deployment and CI/CD](operations/deployment.md): the GitHub Actions deploy job
- [Windows helper scripts](operations/windows-scripts.md): `scripts/*.ps1`

## Development

- [Testing](development/testing.md)
- [Debug mode](development/debug-mode.md)
- [Configuration and tuning](development/configuration.md): every constant worth changing
- [Contributing](development/contributing.md): conventions and gotchas
- [Streamlining candidates](streamlining.md): known structural issues, deferred bugs and dead code worth revisiting
- [How the vision pipeline came to be](vision-pipeline-history.md): what each model was added to fix, and what each one earns for its download size
- [Detection pipeline audit](detection-pipeline-audit.md): per-signal cost and accuracy across the identification pipeline, and which numbers are measured vs simulated
