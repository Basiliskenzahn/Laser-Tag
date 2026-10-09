// Serves the phone client and runs the realtime game over WebSockets.
//
// It listens twice:
//   HTTP  (PORT, default 3000):        localhost on a laptop, or behind an HTTPS tunnel
//   HTTPS (HTTPS_PORT, default 3443):  phones on the same Wi-Fi (self-signed certificate)
// Phones only allow camera access on HTTPS pages, so plain HTTP only works on localhost.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { WebSocketServer } from 'ws';
import { Room } from './game.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const CERT_DIR = path.join(ROOT, '.certs');

// URL prefix -> directory on disk.
const STATIC_DIRS = [
  ['/vendor/tasks-vision/', path.join(ROOT, 'node_modules/@mediapipe/tasks-vision/')],
  ['/', path.join(ROOT, 'public/')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  for (const [prefix, dir] of STATIC_DIRS) {
    if (!urlPath.startsWith(prefix)) continue;
    let file = path.join(dir, urlPath.slice(prefix.length));
    if (!file.startsWith(dir)) break; // path traversal
    if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  res.writeHead(404).end('Not found');
}

async function loadCertificate() {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 1);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'laser-tag.local' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate,
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// ---- Game networking ----

const rooms = new Map(); // code -> Room
const sockets = new Map(); // player id -> ws
const startTimers = new Map(); // room code -> timeout

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(room) {
  const state = room.snapshot();
  for (const id of room.players.keys()) send(sockets.get(id), { type: 'state', state });

  // Push one more update when the countdown ends, so phones flip to "playing" together.
  clearTimeout(startTimers.get(room.code));
  if (state.status === 'countdown') {
    startTimers.set(room.code, setTimeout(() => broadcastState(room), state.startsInMs + 10));
  }
}

function cleanRoomCode(code) {
  return String(code || 'demo').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'demo';
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 20) || 'Player';
}

function handleConnection(ws) {
  const id = crypto.randomUUID();
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join' && !room) {
      const code = cleanRoomCode(msg.room);
      const target = rooms.get(code) ?? new Room(code);
      const result = target.join(id, cleanName(msg.name));
      if (!result.ok) {
        send(ws, { type: 'error', message: result.error });
        return;
      }
      rooms.set(code, target);
      sockets.set(id, ws);
      room = target;
      send(ws, { type: 'welcome', id });
      broadcastState(room);
      return;
    }

    if (!room) return;

    if (msg.type === 'shoot') {
      const result = room.shoot(id, msg.zone);
      if (!result.ok) return;
      send(ws, { type: 'hitConfirmed', zone: result.zone, damage: result.damage, ko: result.ko });
      send(sockets.get(result.victimId), { type: 'gotHit', zone: result.zone, damage: result.damage, ko: result.ko });
      broadcastState(room);
    } else if (msg.type === 'rematch') {
      room.rematch();
      broadcastState(room);
    }
  });

  ws.on('close', () => {
    sockets.delete(id);
    if (!room) return;
    room.leave(id);
    if (room.isEmpty) {
      clearTimeout(startTimers.get(room.code));
      rooms.delete(room.code);
    } else {
      broadcastState(room);
    }
  });
}

// Drop phones that went to sleep without closing the socket.
function startHeartbeat(wss) {
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 10_000).unref();
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

const httpServer = http.createServer(serveStatic);
const httpsServer = https.createServer(await loadCertificate(), serveStatic);

for (const server of [httpServer, httpsServer]) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', handleConnection);
  startHeartbeat(wss);
}

httpServer.listen(PORT, () => {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log('\nLaser Tag server running\n');
    console.log(`  Laptop:  http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  Phones:  https://${ip}:${HTTPS_PORT}`);
    console.log('\nPhones will warn about the self-signed certificate. Accept it to continue.');
    console.log(`For a trusted HTTPS URL instead, run: cloudflared tunnel --url http://localhost:${PORT}\n`);
  });
});
