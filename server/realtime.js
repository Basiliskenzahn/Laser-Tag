// The realtime game server: rooms, players and the WebSocket protocol on top of game.js's
// pure Room logic. No static file serving or TLS here, so this can be attached to any
// http.Server or https.Server - the combined dev server (server/index.js) attaches it to
// both its HTTP and HTTPS listeners; the Docker split's backend container (server/ws-server.js)
// attaches it to a single plain HTTP server instead.

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Room } from './game.js';

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

// Appearance galleries only change when who's in the room changes, so they're pushed
// separately from the frequent state updates above instead of riding along on every shot.
function broadcastRoster(room) {
  const players = room.roster();
  for (const id of room.players.keys()) send(sockets.get(id), { type: 'roster', players });
}

function cleanRoomCode(code) {
  return String(code || 'demo').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'demo';
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 20) || 'Player';
}

// Appearance gallery from enrolment: at most a handful of angle samples, each a couple of
// short numeric vectors. Capped defensively since it comes straight from the client.
function cleanVector(v, maxLen) {
  return Array.isArray(v) ? v.slice(0, maxLen).map(Number).filter(Number.isFinite) : [];
}

function cleanGallery(gallery) {
  if (!Array.isArray(gallery)) return [];
  return gallery.slice(0, 8).map((sample) => ({
    hist: cleanVector(sample?.hist, 64),
    grid: cleanVector(sample?.grid, 256),
  }));
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
      const result = target.join(id, cleanName(msg.name), cleanGallery(msg.gallery));
      if (!result.ok) {
        send(ws, { type: 'error', message: result.error });
        return;
      }
      rooms.set(code, target);
      sockets.set(id, ws);
      room = target;
      send(ws, { type: 'welcome', id });
      broadcastState(room);
      broadcastRoster(room);
      return;
    }

    if (!room) return;

    if (msg.type === 'shoot') {
      const result = room.shoot(id, msg.targetId, msg.zone);
      if (!result.ok) return;
      send(ws, { type: 'hitConfirmed', zone: result.zone, damage: result.damage, ko: result.ko });
      send(sockets.get(result.victimId), { type: 'gotHit', zone: result.zone, damage: result.damage, ko: result.ko });
      broadcastState(room);
    } else if (msg.type === 'start') {
      const result = room.start();
      if (!result.ok) {
        send(ws, { type: 'error', message: result.error });
        return;
      }
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
      broadcastRoster(room);
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

// Attaches the WebSocket game server (path /ws) to an existing http(s).Server.
export function attachGameServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', handleConnection);
  startHeartbeat(wss);
  return wss;
}
