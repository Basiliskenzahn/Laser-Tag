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

// Attaches the WebSocket game server (path /ws) to an existing http(s).Server.
export function attachGameServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', handleConnection);
  startHeartbeat(wss);
  return wss;
}
