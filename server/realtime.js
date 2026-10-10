// The realtime game server: rooms, players and the message protocol on top of game.js's
// pure Room logic. No static file serving or TLS here, so this can be attached to any
// http.Server or https.Server - the combined dev server (server/index.js) attaches it to
// both its HTTP and HTTPS listeners; the Docker split's backend container (server/ws-server.js)
// attaches it to a single plain HTTP server instead.
//
// Phones talk to it over one of two transports carrying the same JSON messages:
//   WebSocket       /ws          preferred, lowest latency
//   HTTP long poll  /api/...     fallback for networks whose proxies reject WebSocket upgrades
//                                (e.g. the hackathon's SSO gateway answers every upgrade with 502)

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Room } from './game.js';

const rooms = new Map(); // code -> Room
const connections = new Map(); // player id -> { send(msg) }, whichever transport they use
const startTimers = new Map(); // room code -> timeout

function sendTo(id, msg) {
  connections.get(id)?.send(msg);
}

function broadcastState(room) {
  const state = room.snapshot();
  for (const id of room.players.keys()) sendTo(id, { type: 'state', state });

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
  for (const id of room.players.keys()) sendTo(id, { type: 'roster', players });
}

function cleanRoomCode(code) {
  return String(code || 'demo').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'demo';
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 20) || 'Player';
}

// Appearance gallery from enrolment: a capped set of angle samples, each a couple of
// short numeric vectors. Capped defensively since it comes straight from the client.
function cleanVector(v, maxLen) {
  return Array.isArray(v) ? v.slice(0, maxLen).map(Number).filter(Number.isFinite) : [];
}

function cleanGallery(gallery) {
  if (!Array.isArray(gallery)) return [];
  return gallery.slice(0, 24).map((sample) => {
    const clean = {
      hist: cleanVector(sample?.hist, 64),
      grid: cleanVector(sample?.grid, 256),
    };
    const lower = cleanVector(sample?.lower, 64);
    const shape = cleanVector(sample?.shape, 8);
    const embed = cleanVector(sample?.embed, 512);
    if (lower.length) clean.lower = lower;
    if (shape.length) clean.shape = shape;
    if (embed.length) clean.embed = embed;
    return clean;
  });
}

// One connected phone, independent of transport. `conn.send(msg)` delivers a message to it;
// the transport calls receive() for each incoming message and close() when it goes away.
function openSession(conn) {
  const id = crypto.randomUUID();
  let room = null;

  function receive(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join' && !room) {
      const code = cleanRoomCode(msg.room);
      const target = rooms.get(code) ?? new Room(code);
      const result = target.join(id, cleanName(msg.name), cleanGallery(msg.gallery));
      if (!result.ok) {
        conn.send({ type: 'error', message: result.error });
        return;
      }
      rooms.set(code, target);
      connections.set(id, conn);
      room = target;
      conn.send({ type: 'welcome', id });
      broadcastState(room);
      broadcastRoster(room);
      return;
    }

    if (!room) return;

    if (msg.type === 'shoot') {
      const result = room.shoot(id, msg.targetId, msg.zone);
      if (!result.ok) return;
      conn.send({ type: 'hitConfirmed', zone: result.zone, damage: result.damage, ko: result.ko });
      sendTo(result.victimId, { type: 'gotHit', zone: result.zone, damage: result.damage, ko: result.ko });
      broadcastState(room);
    } else if (msg.type === 'start') {
      const result = room.start();
      if (!result.ok) {
        conn.send({ type: 'error', message: result.error });
        return;
      }
      broadcastState(room);
    }
  }

  function close() {
    connections.delete(id);
    if (!room) return;
    room.leave(id);
    if (room.isEmpty) {
      clearTimeout(startTimers.get(room.code));
      rooms.delete(room.code);
    } else {
      broadcastState(room);
      broadcastRoster(room);
    }
    room = null;
  }

  return { receive, close };
}

// ---- WebSocket transport ----

function handleWebSocket(ws) {
  const session = openSession({
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  });
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    session.receive(msg);
  });
  ws.on('close', () => session.close());
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

// ---- HTTP long-polling transport ----
//
//   POST /api/connect               -> { token }
//   POST /api/send?token=...        body: one JSON message -> 204
//   GET  /api/poll?token=...        -> JSON array of messages, held open until there is
//                                      something to deliver or POLL_WAIT_MS passes
// An unknown or expired token answers 410, which tells the phone to reconnect.

const POLL_WAIT_MS = 20_000; // under the 30s upstream timeout common in reverse proxies
const POLL_EXPIRY_MS = 30_000; // no poll for this long means the phone is gone
const MAX_BODY_BYTES = 256 * 1024;

const pollers = new Map(); // token -> { queue, waiting, waitTimer, lastSeen, session }
let sweepTimer = null;

function respondJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

// Answers the waiting poll, if any, with everything queued so far.
function flush(poller) {
  if (!poller.waiting) return;
  clearTimeout(poller.waitTimer);
  respondJson(poller.waiting, 200, poller.queue);
  poller.queue = [];
  poller.waiting = null;
}

function closePoller(token) {
  const poller = pollers.get(token);
  if (!poller) return;
  pollers.delete(token);
  clearTimeout(poller.waitTimer);
  if (poller.waiting) respondJson(poller.waiting, 410, { error: 'Session closed' });
  poller.session.close();
}

function sweepPollers() {
  const now = Date.now();
  for (const [token, poller] of pollers) {
    if (!poller.waiting && now - poller.lastSeen > POLL_EXPIRY_MS) closePoller(token);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function connectPoller(res) {
  const token = crypto.randomUUID();
  const poller = { queue: [], waiting: null, waitTimer: null, lastSeen: Date.now(), session: null };
  poller.session = openSession({
    send: (msg) => {
      poller.queue.push(msg);
      flush(poller);
    },
  });
  pollers.set(token, poller);
  sweepTimer ??= setInterval(sweepPollers, 10_000).unref();
  respondJson(res, 200, { token });
}

function poll(poller, req, res) {
  poller.lastSeen = Date.now();
  if (poller.waiting) respondJson(poller.waiting, 200, []); // only one open poll per phone
  poller.waiting = res;
  if (poller.queue.length) {
    flush(poller);
    return;
  }
  poller.waitTimer = setTimeout(() => flush(poller), POLL_WAIT_MS);
  req.on('close', () => {
    // The phone gave up on this poll (network change, page hidden). It counts as seen now,
    // so the session gets the full expiry time to poll again before it's dropped.
    if (poller.waiting === res && !res.writableEnded) {
      clearTimeout(poller.waitTimer);
      poller.waiting = null;
      poller.lastSeen = Date.now();
    }
  });
}

async function receivePosted(poller, req, res) {
  poller.lastSeen = Date.now();
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    if (!res.headersSent) respondJson(res, 400, { error: 'Invalid or oversized JSON body' });
    return;
  }
  poller.session.receive(msg);
  respondJson(res, 204);
}

// Handles /api/* requests. Returns false for anything else, so the caller can serve it.
export function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return false;

  if (req.method === 'POST' && url.pathname === '/api/connect') {
    connectPoller(res);
    return true;
  }

  const isPoll = req.method === 'GET' && url.pathname === '/api/poll';
  const isSend = req.method === 'POST' && url.pathname === '/api/send';
  if (!isPoll && !isSend) {
    respondJson(res, 404, { error: 'Not found' });
    return true;
  }

  const poller = pollers.get(url.searchParams.get('token'));
  if (!poller) respondJson(res, 410, { error: 'Unknown session' });
  else if (isPoll) poll(poller, req, res);
  else receivePosted(poller, req, res);
  return true;
}

// Attaches the WebSocket game server (path /ws) to an existing http(s).Server. The server's
// request handler must also pass /api/* requests to handleHttp() for the polling fallback.
export function attachGameServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', handleWebSocket);
  startHeartbeat(wss);
  return wss;
}
