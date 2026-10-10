# Troubleshooting

## Joining and the camera

**"The camera only works over HTTPS. Open the https:// address the server printed."**
Phones only allow the camera on HTTPS pages (or `localhost`). Use `https://<host-ip>:3443`, not `http://…:8080`.

**"Camera access was blocked."**
Allow camera access for the site in the browser's settings and reload. On iPhone: *Settings → Safari → Camera*. On Android Chrome: tap the icon left of the address bar → *Permissions*.

**"No camera found on this device."**
The browser couldn't find any camera. On a laptop, check that no other app is holding the webcam.

**The certificate warning keeps coming back.**
With Docker, the certificate lives in the `certs` volume and survives restarts. It's only regenerated if the volume is deleted (e.g. `docker compose down -v`). It's valid for 365 days. Using a [tunnel](getting-started.md#if-phones-cant-reach-the-host) avoids the warning altogether.

**"Lobby is already running."**
A round is in progress in that room, and new players can't join mid-round. Wait until it ends, or use a different room code.

**"Room is full"**
A room holds at most 8 players. In debug mode, your debug clone takes one of those slots.

## Connection

**"Connection lost. Reconnecting…"**
The phone lost contact with the server and retries every 1.5 seconds. If it reconnects within about 30 seconds, it resumes as the same player. After that the server drops the player; rejoining then creates a new player, which won't work while a round is running.

**"Can't connect to the game server. Check your internet connection. Still retrying…"**
Two connection attempts in a row failed. Check that:
- the server is running (`docker compose ps`);
- the phone is on the same network as the host;
- the host's firewall allows inbound connections on port 3443 (Windows usually asks the first time Docker opens a port);
- the network doesn't isolate clients. If it does, use a [tunnel](getting-started.md#if-phones-cant-reach-the-host).

## Scanning

**The scan keeps failing.**
Read the hint in the failure message; [How to play → Scanning](how-to-play.md#scanning-a-player) lists what each one means. The most common causes are standing too close (feet or head cut off), turning too fast, and bright backlight. A scan needs at least 12 usable views out of roughly 60 recorded frames.

**Launch says "Scan everyone before launch: …"**
Each listed player needs a scan. Any phone can scan them from the lobby.

## During the game

**Players show up as grey "Person" instead of by name.**
The phone can see someone but isn't confident who it is. Usually:
- two players are dressed too similarly;
- the lighting is very different from where they were scanned;
- the player is too far away, partly out of frame, or turned at an angle the scan didn't cover well.

Rescan the affected players in the playing area. To see *why* a match was rejected, use [debug mode](development/debug-mode.md).

**The crosshair is on a named player but shots don't count.**
A player becomes targetable only after they've been recognised steadily for about 0.35 seconds with good confidence. Hold your aim a moment longer. Also check the outline isn't grey: knocked-out players can't be hit.

**It's slow or laggy.**
Open the game with `?debug` and look at the first overlay line. If it starts with `CPU` instead of `GPU`, the browser couldn't use the GPU for detection, and older phones will struggle. Closing other tabs and apps helps. The detector also runs on a downscaled frame and only every 120–180 ms, so some delay between movement and the outline is normal.

**No vibration when hit on iPhone.**
Safari doesn't support the vibration API. iPhones get the red flash and sound only.

**No sound.**
Browsers only allow audio after you've tapped something. Sound is enabled when you tap **Continue** on the join screen. Check the phone's mute switch and volume.

## Hosting

**`docker` isn't recognised on Windows.**
Docker Desktop may not be on your `PATH`. Run `scripts/add-docker-path.ps1`, or use `scripts/docker.ps1`, which finds Docker on its own. See [Windows helper scripts](operations/windows-scripts.md).

**Models or the detector fail to load ("Could not start: …").**
The client loads MediaPipe's `.mjs`, `.wasm`, `.tflite` and `.task` files. Behind a custom web server, check they're served with the correct MIME types (`text/javascript` for `.mjs`, `application/wasm` for `.wasm`). The bundled nginx config already does this; see [Docker setup](operations/docker.md#nginx).
