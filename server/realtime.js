// The realtime game server: rooms, players and the message protocol on top of game.js's
// pure Room logic. No static file serving or TLS here; server/index.js handles those for
// local development, while Docker uses the Python backend.
//
// Phones use HTTP long polling for game control/state and SSE for health/death events.

import crypto from 'node:crypto';
import { MAX_PLAYERS, Room } from './game.js';

const rooms = new Map(); // code -> Room
const connections = new Map(); // player id -> { send(msg) }, whichever transport they use
const startTimers = new Map(); // room code -> timeout
const eventStreams = new Map(); // room code -> Set<http.ServerResponse> for local-dev SSE

// Motion activity from a phone: [[t_ms, activity], ...], capped since it comes from the client.
const MAX_MOTION_SAMPLES = 32;

function cleanMotionSamples(samples) {
  if (!Array.isArray(samples)) return [];
  return samples
    .slice(0, MAX_MOTION_SAMPLES)
    .filter((s) => Array.isArray(s) && s.length >= 2)
    .map(([t, v]) => [Math.trunc(Number(t)), Math.round(Number(v) * 100) / 100])
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && v >= 0);
}

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

function sendRoomEvent(room, event) {
  const streams = eventStreams.get(room.code);
  if (!streams?.size) return;
  const data = `event: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) res.write(data);
}

function processHit(room, shooterId, targetId, zone) {
  const result = room.shoot(shooterId, targetId, zone);
  if (!result.ok) return result;
  const target = room.players.get(result.victimId);
  const enriched = { ...result, hp: target?.hp ?? 0, alive: target?.alive ?? false };
  sendTo(shooterId, { type: 'hitConfirmed', zone: result.zone, damage: result.damage, ko: result.ko });
  sendTo(result.victimId, { type: 'gotHit', zone: result.zone, damage: result.damage, ko: result.ko });
  sendRoomEvent(room, {
    type: 'health',
    room: room.code,
    shooterId,
    targetId: result.victimId,
    zone: result.zone,
    damage: result.damage,
    hp: enriched.hp,
    alive: enriched.alive,
  });
  if (result.ko) sendRoomEvent(room, { type: 'death', room: room.code, playerId: result.victimId, killerId: shooterId });
  broadcastState(room);
  return enriched;
}

function cleanRoomCode(code) {
  return String(code || 'demo').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'demo';
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 20) || 'Player';
}

function cleanPlayerId(id) {
  const clean = String(id || '').trim();
  return /^[a-zA-Z0-9:-]{8,80}$/.test(clean) ? clean : '';
}

// Appearance gallery from enrolment: a capped set of angle samples, each a couple of
// short numeric vectors. Capped defensively since it comes straight from the client.
const GALLERY_FIELDS = [
  ['hist', 64, true],
  ['grid', 256, true],
  ['lower', 64],
  ['shape', 8],
  ['embed', 512],
  ['reid', 512], // person re-identification embedding (public/reid.js)
];

function cleanVector(v, maxLen) {
  return Array.isArray(v) ? v.slice(0, maxLen).map(Number).filter(Number.isFinite) : [];
}

function cleanGallery(gallery) {
  if (!Array.isArray(gallery)) return [];
  return gallery.slice(0, 24).map((sample) => {
    const clean = {};
    for (const [field, maxLen, required] of GALLERY_FIELDS) {
      const vector = cleanVector(sample?.[field], maxLen);
      if (required || vector.length) clean[field] = vector;
    }
    return clean;
  });
}

// One connected phone, independent of transport. `conn.send(msg)` delivers a message to it;
// the transport calls receive() for each incoming message and close() when it goes away.
function openSession(conn) {
  let id = crypto.randomUUID();
  let cloneId = `${id}:debug-clone`;
  let room = null;

  function receive(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join' && !room) {
      const code = cleanRoomCode(msg.room);
      const target = rooms.get(code) ?? new Room(code);
      const name = cleanName(msg.name);
      const gallery = cleanGallery(msg.gallery);
      const requestedId = cleanPlayerId(msg.playerId);
      if (requestedId && target.players.has(requestedId)) {
        id = requestedId;
        cloneId = `${id}:debug-clone`;
        room = target;
        connections.set(id, conn);
        conn.send({ type: 'welcome', id });
        broadcastState(room);
        broadcastRoster(room);
        return;
      }
      if (msg.debug === true && target.players.size > MAX_PLAYERS - 2) {
        conn.send({ type: 'error', message: 'Room is full' });
        return;
      }
      const result = target.join(id, name, gallery);
      if (!result.ok) {
        conn.send({ type: 'error', message: result.error });
        return;
      }
      if (msg.debug === true) {
        const clone = target.join(cloneId, `${name} clone`, gallery);
        if (!clone.ok) {
          target.leave(id);
          conn.send({ type: 'error', message: clone.error });
          return;
        }
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
      processHit(room, id, msg.targetId, msg.zone);
    } else if (msg.type === 'scan') {
      const gallery = cleanGallery(msg.gallery);
      const result = room.setGallery(msg.targetId, gallery);
      if (!result.ok) {
        conn.send({ type: 'error', message: result.error });
        return;
      }
      conn.send({ type: 'scanSaved', targetId: msg.targetId });
      broadcastRoster(room);
      broadcastState(room);
    } else if (msg.type === 'motion') {
      // Relay this phone's motion activity to everyone else in the room for motion matching.
      const s = cleanMotionSamples(msg.s);
      if (s.length) for (const other of room.players.keys()) if (other !== id) sendTo(other, { type: 'motion', from: id, s });
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
    if (connections.get(id) !== conn) return;
    connections.delete(id);
    if (!room) return;
    room.leave(id);
    room.leave(cloneId);
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

// ---- HTTP long-polling transport ----
//
//   POST /api/connect               -> { token }
//   POST /api/send?token=...        body: one JSON message -> 204
//   GET  /api/poll?token=...        -> JSON array of messages, held open until there is
//                                      something to deliver or POLL_WAIT_MS passes
// An unknown or expired token answers 410, which tells the phone to reconnect.

const POLL_WAIT_MS = 20_000; // under the 30s upstream timeout common in reverse proxies
const POLL_EXPIRY_MS = 30_000; // no poll for this long means the phone is gone
const MAX_BODY_BYTES = 1024 * 1024; // a 24-sample scan with re-identification embeddings is ~210 KB

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

function disconnectPoller(token, res) {
  closePoller(token);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
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

async function receiveHit(req, res) {
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    respondJson(res, 400, { ok: false, error: 'Invalid or oversized JSON body' });
    return;
  }
  const shooterId = msg?.shooterId;
  const room = rooms.get(cleanRoomCode(msg?.room)) ?? [...rooms.values()].find((candidate) => candidate.players.has(shooterId));
  if (!room) {
    respondJson(res, 404, { ok: false, error: 'Unknown player' });
    return;
  }
  const result = processHit(room, shooterId, msg?.targetId, msg?.zone);
  respondJson(res, result.ok ? 200 : 400, result);
}

function openEvents(roomCode, req, res) {
  const code = cleanRoomCode(roomCode);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const streams = eventStreams.get(code) ?? new Set();
  streams.add(res);
  eventStreams.set(code, streams);
  req.on('close', () => {
    streams.delete(res);
    if (!streams.size) eventStreams.delete(code);
  });
}

// Handles /api/* and /events/* requests. Returns false for anything else, so the caller can serve it.
export function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname.startsWith('/events/')) {
    openEvents(decodeURIComponent(url.pathname.slice('/events/'.length)), req, res);
    return true;
  }
  if (!url.pathname.startsWith('/api/')) return false;

  if (req.method === 'POST' && url.pathname === '/api/connect') {
    connectPoller(res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/hit') {
    receiveHit(req, res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/disconnect') {
    disconnectPoller(url.searchParams.get('token'), res);
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
