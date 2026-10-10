# Getting started

The fastest path from a fresh clone to a game running on phones.

## Requirements

- **Host:** Docker Desktop or Docker Engine with Compose. (Alternatively Node.js 20+, see [Node dev server](server/node-dev-server.md).)
- **Players:** one phone each, with a rear camera and a recent Chrome, Safari or Firefox.
- **Network:** host and phones on the same Wi-Fi, or a tunnel (below).
- **Space:** enough room for players to see each other's whole body from a few metres away.

## 1. Start the server

```bash
docker compose up --build
```

This serves:

| Address | For |
| --- | --- |
| `http://localhost:8080` | The host machine itself. Browsers allow the webcam on `localhost` over plain HTTP. |
| `https://<host-lan-ip>:3443` | Phones on the same Wi-Fi. |

Find the host's LAN IP yourself; the container logs don't know it. On Windows run `ipconfig` and use the Wi-Fi adapter's "IPv4 Address". On macOS use `ipconfig getifaddr en0`, on Linux `ip addr`.

More about what this starts: [Docker setup](operations/docker.md).

## 2. Open it on every phone

1. Open `https://<host-lan-ip>:3443`.
2. Accept the certificate warning. The server signs its own certificate, and phones only allow camera access over HTTPS.
   - **iPhone:** *Show Details* → *visit this website*.
   - **Android:** *Advanced* → *Proceed*.
3. Enter a name and the **same room code** as everyone else, then allow camera access.

Tip: share a link with the room code pre-filled, e.g. `https://192.168.1.23:3443/?room=friday`.

## 3. Play

Scan every player from the lobby, then tap **Launch**. Details: [How to play](how-to-play.md).

## If phones can't reach the host

Many campus, office and public networks block devices on the same Wi-Fi from talking to each other. Run an HTTPS tunnel and open its URL on the phones instead. As a bonus, the tunnel's certificate is trusted, so there's no warning to click through.

```bash
# install once
brew install cloudflared                      # macOS
winget install --id Cloudflare.cloudflared    # Windows

cloudflared tunnel --url http://localhost:8080
```

Open the printed `https://….trycloudflare.com` URL on every phone. The game uses plain HTTP requests rather than WebSockets, so it works through tunnels and proxies without extra setup.

## Trying it alone

Open `http://localhost:8080/?debug` on a laptop. Debug mode adds a fake second player that copies your scan, so you can scan yourself, launch a round, and fire with the **Space** key. See [Debug mode](development/debug-mode.md).
