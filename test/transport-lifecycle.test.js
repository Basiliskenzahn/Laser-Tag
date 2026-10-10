// What can and cannot take the polling connection down (frontend/public/transport.js).
//
// Two things used to be able to, and neither should: a send that failed, and a message handler
// that threw. The first closed the connection and dropped the message with the caller none the
// wiser; the second closed the connection, which reconnected, which re-joined, which received the
// same bad message again, for ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeServer, flush } from './helpers/fake-server.js';

const { openPolling } = await import('../frontend/public/transport.js');

// A connection on a fake server, with the retry delay taken out so the tests need no clock.
async function open(handlers = {}) {
  const server = createFakeServer();
  globalThis.fetch = server.fetch;
  globalThis.navigator ??= {};
  const closes = [];
  const seen = [];
  const conn = openPolling({
    onOpen: handlers.onOpen ?? (() => {}),
    onMessage: handlers.onMessage ?? ((msg) => seen.push(msg)),
    onClose: handlers.onClose ?? (() => closes.push(1)),
    sendRetryMs: 0,
    ...(handlers.sendAttempts === undefined ? {} : { sendAttempts: handlers.sendAttempts }),
  });
  await server.settle();
  return { server, conn, closes, seen };
}

test('a delivered message resolves true, and the sends go out in order', async () => {
  const { server, conn } = await open();
  const results = await Promise.all([conn.send({ n: 1 }), conn.send({ n: 2 }), conn.send({ n: 3 })]);
  assert.deepEqual(results, [true, true, true]);
  assert.deepEqual(
    server.sends.map((msg) => msg.n),
    [1, 2, 3],
  );
  conn.close();
});

test('one transient failure on a send is retried rather than thrown away', async () => {
  // The trigger this is for: a single error on the ~190 KB scan gallery POST.
  const { server, conn, closes } = await open();
  server.sendFailures = 1;
  const gallery = { type: 'scan', targetId: 'p1', gallery: [1, 2, 3] };
  assert.equal(await conn.send(gallery), true, 'the retry got it there');
  assert.equal(server.refusedSends, 1, 'the first attempt really was refused');
  assert.deepEqual(server.sends, [gallery], 'and it arrived exactly once');
  assert.deepEqual(closes, [], 'a retried send does not close the connection');
  conn.close();
});

test('a send that cannot be delivered at all is reported to the caller, not swallowed', async () => {
  const { server, conn } = await open();
  server.sendFailures = 50; // every attempt refused
  assert.equal(await conn.send({ type: 'scan' }), false);
  assert.deepEqual(server.sends, [], 'nothing reached the server');
  conn.close();
});

test('a send that cannot be delivered leaves the connection up', async () => {
  // It used to close it: the caller lost the message *and* the token, so there was nothing left
  // to retry with. Deciding the connection is gone belongs to the poll loop alone.
  const { server, conn, closes, seen } = await open();
  server.sendFailures = 50;
  assert.equal(await conn.send({ type: 'scan' }), false);
  assert.deepEqual(closes, [], 'no onClose');
  assert.equal(server.connects, 1, 'and so no reconnect');

  // Still live: a later message still arrives, and a later send still goes out.
  server.sendFailures = 0;
  server.push({ type: 'roster' });
  await server.settle();
  assert.deepEqual(seen, [{ type: 'roster' }]);
  assert.equal(await conn.send({ type: 'start' }), true);
  conn.close();
});

test('a send attempted with no connection resolves false instead of doing nothing', async () => {
  const { conn } = await open();
  conn.close();
  assert.equal(await conn.send({ type: 'scan' }), false);
});

test('a message handler that throws does not close the connection', async () => {
  // The infinite-reconnect loop: the throw reached the poll loop's catch, so the client closed,
  // reconnected, re-joined, and the server replayed the same message. `opened` was already true
  // by then, so nothing counted the failures and nothing ever stopped it.
  const seen = [];
  const closes = [];
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const { server, conn } = await open({
      onMessage(msg) {
        if (msg.type === 'poison') throw new Error('handler blew up');
        seen.push(msg);
      },
      onClose: () => closes.push(1),
    });
    server.push({ type: 'poison' }, { type: 'roster' });
    await server.settle();

    assert.deepEqual(closes, [], 'the connection stayed open');
    assert.equal(server.connects, 1, 'and nothing reconnected');
    assert.deepEqual(seen, [{ type: 'roster' }], 'the messages behind the bad one still arrived');

    // And it is genuinely still polling afterwards, not merely un-closed.
    server.push({ type: 'state' });
    await server.settle();
    assert.deepEqual(seen, [{ type: 'roster' }, { type: 'state' }]);
    assert.equal(errors.length, 1, 'the throw was logged rather than hidden');
    conn.close();
  } finally {
    console.error = realError;
  }
});

test('a fetch that fails is still a closed connection', async () => {
  // The other half of the same change: separating dispatch from transport failure must not have
  // stopped a real network failure from closing the connection.
  const { server, closes } = await open();
  server.drop();
  await flush();
  assert.deepEqual(closes, [1]);
});

test('closing twice tells the server to drop us exactly once', async () => {
  const { server, conn } = await open();
  const beacons = [];
  globalThis.navigator.sendBeacon = (path) => {
    beacons.push(path);
    return true;
  };
  conn.close({ notify: true });
  conn.close({ notify: true });
  assert.equal(beacons.length, 1);
  assert.match(beacons[0], /^\/api\/disconnect\?token=token-1$/);
  assert.deepEqual(server.disconnects, [], 'the beacon was used, so no fetch fallback');
  delete globalThis.navigator.sendBeacon;
});

test('with no sendBeacon the goodbye falls back to a keepalive fetch, still once', async () => {
  const { server, conn } = await open();
  conn.close({ notify: true });
  conn.close({ notify: true });
  await flush();
  assert.equal(server.disconnects.length, 1);
});
