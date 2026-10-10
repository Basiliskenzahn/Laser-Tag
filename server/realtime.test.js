import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleHttp } from './realtime.js';

const server = http.createServer((req, res) => {
  if (!handleHttp(req, res)) res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

after(() => {
  server.closeAllConnections();
  server.close();
});

// A polling client like the phone's fallback transport, collecting every message it receives.
async function pollingClient() {
  const { token } = await (await fetch(`${base}/api/connect`, { method: 'POST' })).json();
  const messages = [];
  const aborter = new AbortController();
  (async () => {
    try {
      while (true) {
        const res = await fetch(`${base}/api/poll?token=${token}`, { signal: aborter.signal });
        if (!res.ok) return;
        messages.push(...(await res.json()));
      }
    } catch {
      // Stopped, or the server shut down.
    }
  })();
  return {
    token,
    messages,
    send: (msg) =>
      fetch(`${base}/api/send?token=${token}`, { method: 'POST', body: JSON.stringify(msg) }),
    stop: () => aborter.abort(),
  };
}

async function waitFor(check, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function readSseEvent(response, type, ms = 2000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => reader.cancel(), ms);
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const raw of events) {
        const lines = raw.split('\n');
        const eventName = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        if (eventName === type && data) return JSON.parse(data);
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => {});
  }
  throw new Error(`Timed out waiting for ${type} SSE event`);
}

const gallery = [{ hist: [1, 0], grid: [0, 1] }];
const lastState = (messages) => messages.filter((m) => m.type === 'state').at(-1)?.state;

test('two polling players can join, see each other and start a round', async () => {
  const a = await pollingClient();
  const b = await pollingClient();
  await a.send({ type: 'join', name: 'A', room: 'poll', gallery });
  await b.send({ type: 'join', name: 'B', room: 'poll', gallery });

  await waitFor(() => lastState(a.messages)?.players.length === 2);
  await waitFor(() => a.messages.filter((m) => m.type === 'roster').at(-1)?.players.length === 2);
  assert.ok(a.messages.some((m) => m.type === 'welcome'));

  await b.send({ type: 'start' });
  await waitFor(() => lastState(a.messages)?.status === 'countdown');
  a.stop();
  b.stop();
});

test('a held poll is answered as soon as a message arrives', async () => {
  const a = await pollingClient();
  await a.send({ type: 'join', name: 'A', room: 'latency', gallery });
  await waitFor(() => a.messages.length > 0);
  const before = a.messages.length;

  const b = await pollingClient();
  const sentAt = Date.now();
  await b.send({ type: 'join', name: 'B', room: 'latency', gallery });
  await waitFor(() => a.messages.length > before);
  assert.ok(Date.now() - sentAt < 1000, 'update should arrive without waiting for the poll timeout');
  a.stop();
  b.stop();
});

test('unknown polling sessions are told to reconnect', async () => {
  assert.equal((await fetch(`${base}/api/poll?token=nope`)).status, 410);
  assert.equal((await fetch(`${base}/api/send?token=nope`, { method: 'POST', body: '{}' })).status, 410);
});

test('shots and damage travel over polling', async () => {
  const a = await pollingClient();
  const b = await pollingClient();
  await a.send({ type: 'join', name: 'A', room: 'shoot', gallery });
  await b.send({ type: 'join', name: 'B', room: 'shoot', gallery });
  await waitFor(() => lastState(a.messages)?.players.length === 2);
  const bId = b.messages.find((m) => m.type === 'welcome').id;

  await a.send({ type: 'start' });
  await waitFor(() => lastState(a.messages)?.status === 'playing', 5000);
  await a.send({ type: 'shoot', targetId: bId, zone: 'body' });

  await waitFor(() => a.messages.some((m) => m.type === 'hitConfirmed'));
  await waitFor(() => b.messages.some((m) => m.type === 'gotHit'));
  await waitFor(() => lastState(b.messages)?.players.find((p) => p.id === bId).hp === 80);
  a.stop();
  b.stop();
});

test('posted hits emit health updates over SSE', async () => {
  const a = await pollingClient();
  const b = await pollingClient();
  const room = 'posted-hit';
  await a.send({ type: 'join', name: 'A', room, gallery });
  await b.send({ type: 'join', name: 'B', room, gallery });
  await waitFor(() => lastState(a.messages)?.players.length === 2);
  const aId = a.messages.find((m) => m.type === 'welcome').id;
  const bId = b.messages.find((m) => m.type === 'welcome').id;
  const events = await fetch(`${base}/events/${room}`);
  assert.equal(events.ok, true);

  await a.send({ type: 'start' });
  await waitFor(() => lastState(a.messages)?.status === 'playing', 5000);
  const res = await fetch(`${base}/api/hit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, shooterId: aId, targetId: bId, zone: 'body' }),
  });

  assert.equal(res.status, 200);
  assert.equal((await res.json()).hp, 80);
  const event = await readSseEvent(events, 'health');
  assert.equal(event.shooterId, aId);
  assert.equal(event.targetId, bId);
  assert.equal(event.hp, 80);
  await waitFor(() => b.messages.some((m) => m.type === 'gotHit'));
  a.stop();
  b.stop();
});

test('debug sessions get a targetable clone instead of self hits', async () => {
  const debug = await pollingClient();
  await debug.send({ type: 'join', name: 'Debug', room: 'clone-hit', gallery, debug: true });
  await waitFor(() => lastState(debug.messages)?.players.length === 2);
  const debugId = debug.messages.find((m) => m.type === 'welcome').id;
  const clone = lastState(debug.messages).players.find((p) => p.id !== debugId);
  assert.equal(clone.name, 'Debug clone');
  await waitFor(() => debug.messages.filter((m) => m.type === 'roster').at(-1)?.players.find((p) => p.id === clone.id)?.gallery.length === 1);

  await debug.send({ type: 'start' });
  await waitFor(() => lastState(debug.messages)?.status === 'playing', 5000);

  await debug.send({ type: 'shoot', targetId: debugId, zone: 'body' });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(lastState(debug.messages)?.players.find((p) => p.id === debugId).hp, 100);

  await debug.send({ type: 'shoot', targetId: clone.id, zone: 'body' });
  await waitFor(() => lastState(debug.messages)?.players.find((p) => p.id === clone.id).hp === 80);

  debug.stop();
});
