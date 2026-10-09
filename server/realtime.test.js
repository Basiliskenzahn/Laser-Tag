import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { attachGameServer, handleHttp } from './realtime.js';

const server = http.createServer((req, res) => {
  if (!handleHttp(req, res)) res.writeHead(404).end();
});
const wss = attachGameServer(server);
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

after(() => {
  for (const ws of wss.clients) ws.terminate();
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

function wsClient() {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, messages, send: (m) => ws.send(JSON.stringify(m)) })));
}

async function waitFor(check, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
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

test('WebSocket and polling players share a room', async () => {
  const w = await wsClient();
  const p = await pollingClient();
  w.send({ type: 'join', name: 'Socket', room: 'mixed', gallery });
  await waitFor(() => lastState(w.messages)?.players.length === 1);
  await p.send({ type: 'join', name: 'Poller', room: 'mixed', gallery });

  await waitFor(() => lastState(w.messages)?.players.length === 2);
  await waitFor(() => lastState(p.messages)?.players.length === 2);
  w.ws.close();
  await waitFor(() => lastState(p.messages)?.players.length === 1);
  p.stop();
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
