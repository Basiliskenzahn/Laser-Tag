// Leaving a room has to give back everything the motion identity provider took out
// (frontend/public/motion-identity.js, frontend/public/motion/sensor.js).
//
// None of it used to come back: the 500 ms flush interval ran for the life of the page, the
// devicemotion listener stayed attached because nothing ever called MotionSensor.stop(), and
// remoteActivity accumulated a player id for every room the phone had ever been in.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { flush } from './helpers/fake-server.js';
import { installBrowserStubs } from './helpers/dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);
// The provider under test is only installed with ?motion=on, and env.js reads the query string at
// import time, so it has to be set before anything below is imported.
const dom = installBrowserStubs({ search: '?motion=on' });
globalThis.DeviceMotionEvent = class {}; // present, and with no requestPermission: granted

const { identity } = await import('../frontend/public/identity.js');
const { motionIdentity } = await import('../frontend/public/motion-identity.js');
const { MotionSensor } = await import('../frontend/public/motion/sensor.js');
const { state } = await import('../frontend/public/state.js');

const devicemotionListeners = () => (dom.windowListeners.get('devicemotion') ?? []).length;

// setInterval is the leak itself, so the test has to watch the timer rather than its effects.
let intervalsStarted;
let intervalsCleared;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

beforeEach(() => {
  identity.stop();
  dom.reset();
  dom.windowListeners.clear();
  intervalsStarted = [];
  intervalsCleared = [];
  globalThis.setInterval = (fn, ms) => {
    const handle = realSetInterval(fn, ms);
    intervalsStarted.push({ handle, ms });
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    intervalsCleared.push(handle);
    return realClearInterval(handle);
  };
  state.myId = 'me';
  state.game = null;
});

test('?motion=on installs the motion provider, and it answers the seam including stop', () => {
  assert.equal(identity, motionIdentity, 'precondition: the provider under test is the installed one');
  for (const name of ['start', 'stop', 'observe', 'resolve', 'onServerMessage', 'debugLine']) {
    assert.equal(typeof identity[name], 'function', `the seam answers ${name}`);
  }
});

test('starting takes a sensor and a flush interval; stopping gives both back', async () => {
  identity.start();
  await flush();

  assert.equal(devicemotionListeners(), 1, 'the sensor is listening');
  assert.equal(intervalsStarted.length, 1, 'and the outgoing samples are being flushed');
  assert.equal(intervalsStarted[0].ms, 500);

  identity.stop();

  assert.equal(devicemotionListeners(), 0, 'the devicemotion listener is gone');
  assert.deepEqual(
    intervalsCleared,
    [intervalsStarted[0].handle],
    'and the flush interval was cleared, not left running for the life of the page',
  );
});

test('stopping forgets the activity every player id reported', async () => {
  state.game = { players: [{ id: 'old-room-player', name: 'Ghost', alive: true }] };
  identity.start();
  await flush();

  identity.onServerMessage({ type: 'motion', from: 'old-room-player', s: [[Date.now(), 1.2]] });
  assert.match(identity.debugLine(0, []), /from Ghost/, 'precondition: that id is being tracked');

  identity.stop();

  const line = identity.debugLine(0, []);
  assert.doesNotMatch(line, /Ghost/, 'ids do not accumulate across rooms');
  assert.match(line, /from nobody/);
  assert.match(line, /^motion off/, 'and the sensor reads as off, not as a sensor with no data');
});

test('stopping while the permission prompt is still up starts nothing behind it', async () => {
  // iOS shows the prompt and the player can take as long as they like over it - long enough to
  // give up and leave the room first.
  let grant;
  const realRequest = MotionSensor.requestPermission;
  MotionSensor.requestPermission = () => new Promise((resolve) => (grant = resolve));
  try {
    identity.start();
    identity.stop();
    grant(true);
    await flush();

    assert.equal(devicemotionListeners(), 0);
    assert.equal(intervalsStarted.length, 0);
  } finally {
    MotionSensor.requestPermission = realRequest;
  }
});

test('starting again after a stop works', async () => {
  identity.start();
  await flush();
  identity.stop();
  identity.start();
  await flush();
  assert.equal(devicemotionListeners(), 1);
  assert.equal(intervalsStarted.length, 2);
  identity.stop();
});

test('stopping twice, or stopping a sensor that never started, is harmless', () => {
  const sensor = new MotionSensor();
  sensor.stop(); // never started
  sensor.start();
  assert.equal(devicemotionListeners(), 1);
  sensor.stop();
  sensor.stop();
  assert.equal(devicemotionListeners(), 0);
  identity.stop();
  identity.stop();
});

test('a stopped sensor cannot flush a half-filled bin into its outgoing samples', () => {
  const sensor = new MotionSensor();
  sensor.start();
  const listener = (dom.windowListeners.get('devicemotion') ?? [])[0];
  listener({ acceleration: { x: 1, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 } });
  sensor.stop();
  assert.deepEqual(sensor.takeOutgoing(), [], 'the bin went with the listener');
});
