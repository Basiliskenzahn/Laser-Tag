// Leaving a room has to give back everything motion took out (frontend/public/motion/index.js,
// frontend/public/motion/sensor.js), and net.js's leaveRoom() has to be what does it.
//
// None of it used to come back: the 500 ms flush interval ran for the life of the page, the
// devicemotion listener stayed attached because nothing ever called MotionSensor.stop(), and the
// remote activity map accumulated an entry for every room the phone had ever been in. A phone
// parked back on the join screen kept waking its accelerometer and sending samples to a room it
// had left.
//
// net.js is driven for real here rather than stubbed, because "stopMotion exists" was never the
// bug - "nothing calls it" was.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { flush } from './helpers/fake-server.js';
import { installBrowserStubs } from './helpers/dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);
// Motion only runs with ?motion=on, and env.js reads the query string at import time, so it has
// to be set before anything below is imported.
const dom = installBrowserStubs({ search: '?motion=on' });
globalThis.DeviceMotionEvent = class {}; // present, and with no requestPermission: granted

const net = await import('../frontend/public/net.js');
const motion = await import('../frontend/public/motion/index.js');
const { MotionSensor } = await import('../frontend/public/motion/sensor.js');
const { state } = await import('../frontend/public/state.js');

const devicemotionListeners = () => (dom.windowListeners.get('devicemotion') ?? []).length;

// setInterval is the leak itself, so the test has to watch the timer rather than its effects: a
// cleared interval and a live one whose sensor has been nulled both send nothing. These stand in
// for the real timers rather than wrapping them, because an interval this file failed to clear
// would otherwise keep the test process alive for ever instead of failing it.
let intervalsStarted;
let intervalsCleared;
let sent;

beforeEach(() => {
  net.leaveRoom();
  dom.reset();
  dom.windowListeners.clear();
  intervalsStarted = [];
  intervalsCleared = [];
  sent = [];
  globalThis.setInterval = (fn, ms) => {
    const handle = { id: intervalsStarted.length, fn };
    intervalsStarted.push({ handle, ms, fn });
    return handle;
  };
  globalThis.clearInterval = (handle) => intervalsCleared.push(handle);
  state.myId = 'me';
  state.game = null;
});

const start = () => motion.startMotion((msg) => sent.push(msg));

test('starting takes a sensor and a flush interval; stopping gives both back', async () => {
  start();
  await flush();

  assert.equal(devicemotionListeners(), 1, 'the sensor is listening');
  assert.equal(intervalsStarted.length, 1, 'and the outgoing samples are being flushed');
  assert.equal(intervalsStarted[0].ms, motion.MOTION_SEND_INTERVAL_MS);

  motion.stopMotion();

  assert.equal(devicemotionListeners(), 0, 'the devicemotion listener is gone');
  assert.deepEqual(
    intervalsCleared,
    [intervalsStarted[0].handle],
    'and the flush interval was cleared, not left running for the life of the page',
  );
});

test('leaveRoom() is what tears it down - the wiring, not just the function', async () => {
  // This is the actual defect. stopMotion() was added to the old provider seam shortly before the
  // subsystem was deleted; what made it a leak for the life of the page was that the leave path
  // never called it.
  state.game = { players: [{ id: 'old-room-player', name: 'Ghost', alive: true }] };
  start();
  await flush();
  motion.onMotionMessage({ type: 'motion', from: 'old-room-player', s: [[Date.now(), 1.2]] });
  assert.match(motion.motionDebugLine(0, []), /from Ghost:1/, 'precondition: that id is being tracked');
  assert.equal(devicemotionListeners(), 1, 'precondition: the sensor is listening');

  net.leaveRoom();

  assert.equal(devicemotionListeners(), 0, 'leaving a room stops the accelerometer');
  assert.deepEqual(intervalsCleared, [intervalsStarted[0].handle], 'and the flush interval');
  const line = motion.motionDebugLine(0, []);
  assert.doesNotMatch(line, /Ghost/, 'and player ids do not accumulate across rooms');
  assert.match(line, /from nobody/);
  assert.match(line, /^motion off/, 'the sensor reads as off, not as a sensor with no data');
});

test('the flush interval sends this phone\'s samples, and sends nothing when there are none', async () => {
  start();
  await flush();
  const tick = intervalsStarted[0].fn;

  tick();
  assert.deepEqual(sent, [], 'an idle phone must not send an empty message every 500 ms');

  // A bin is closed only by an event that lands in the next one, so the clock is driven rather
  // than left to fall where it may - otherwise whether this test asserts anything at all depends
  // on where the 100 ms boundaries happened to land.
  const realNow = Date.now;
  let clock = 1_000_000; // exactly on a bin boundary
  Date.now = () => clock;
  try {
    const shake = (x) => (dom.windowListeners.get('devicemotion') ?? [])[0]({ acceleration: { x, y: 0, z: 0 }, rotationRate: {} });
    shake(2); // opens the bin ending at 1_000_000
    clock += 150; // into the next bin, which closes the first
    shake(2);
    tick();

    assert.equal(sent.length, 1, 'one flush, one message');
    assert.equal(sent[0].type, 'motion');
    assert.deepEqual(sent[0].s, [[1_000_000, 2]], 'the closed bin: its end time and its RMS');

    tick();
    assert.equal(sent.length, 1, 'and takeOutgoing() drains, so the same sample is not sent twice');
  } finally {
    Date.now = realNow;
  }
  motion.stopMotion();
});

test('stopping while the permission prompt is still up starts nothing behind it', async () => {
  // iOS shows the prompt and the player can take as long as they like over it - long enough to
  // give up and leave the room first.
  let grant;
  const realRequest = MotionSensor.requestPermission;
  MotionSensor.requestPermission = () => new Promise((resolve) => (grant = resolve));
  try {
    start();
    motion.stopMotion();
    grant(true);
    await flush();

    assert.equal(devicemotionListeners(), 0);
    assert.equal(intervalsStarted.length, 0);
  } finally {
    MotionSensor.requestPermission = realRequest;
  }
});

test('starting again after a stop works', async () => {
  start();
  await flush();
  motion.stopMotion();
  start();
  await flush();
  assert.equal(devicemotionListeners(), 1);
  assert.equal(intervalsStarted.length, 2);
  motion.stopMotion();
});

test('starting twice does not take two sensors', async () => {
  start();
  start();
  await flush();
  assert.equal(devicemotionListeners(), 1, 'the second start is a no-op while one is pending');
  assert.equal(intervalsStarted.length, 1);
  start();
  await flush();
  assert.equal(devicemotionListeners(), 1, 'and a no-op once one is running');
  assert.equal(intervalsStarted.length, 1);
  motion.stopMotion();
});

test('a sensor can be started and stopped any number of times without stacking listeners', () => {
  // Both halves are asserted on the class directly, because startMotion() never calls either one
  // twice on the same instance - it builds a fresh sensor every time and guards with its own
  // `sensor || permissionPending` check. So the module-level test above cannot reach these, and
  // without this one `start()`'s guard was unasserted. (Observed: deleting it survived.)
  const sensor = new MotionSensor();
  sensor.stop(); // never started
  assert.equal(devicemotionListeners(), 0);

  sensor.start();
  sensor.start();
  assert.equal(devicemotionListeners(), 1, 'a second start must not attach a second listener');

  sensor.stop();
  sensor.stop();
  assert.equal(devicemotionListeners(), 0, 'and one stop is enough to detach it');

  motion.stopMotion();
  motion.stopMotion();
});

test('a sensor stopped and started again does not flush the bin that was open when it stopped', () => {
  // The 100 ms bin being filled when stop() lands has no business surviving into the next room:
  // the first event after a restart crosses its boundary, so a kept bin would flush a sample
  // stamped with the old room's time into the stream every other phone correlates against.
  // startMotion() always builds a fresh MotionSensor, so this is the class holding its own line
  // rather than a bug reachable through the module.
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const sensor = new MotionSensor();
    const shake = () => (dom.windowListeners.get('devicemotion') ?? [])[0]({
      acceleration: { x: 1, y: 0, z: 0 },
      rotationRate: {},
    });

    sensor.start();
    shake();
    sensor.stop();

    clock += 60_000; // a long time later, in another room
    sensor.start();
    shake();

    assert.deepEqual(sensor.takeOutgoing(), [], 'nothing from the bin that was open at the stop');
    sensor.stop();
  } finally {
    Date.now = realNow;
  }
});

test('a sample stamped far in the future is dropped instead of lodging in the history for ever', () => {
  // The history was trimmed only at the old end, so a sample stamped ahead of the clock never
  // became older than the cutoff and was never removed: one entry per message accumulated for as
  // long as the room lasted. It could never land inside the 6 s the correlation looks at either,
  // so there was nothing to lose by dropping it.
  state.game = { players: [{ id: 'spammer', name: 'Spam', alive: true }] };
  const now = Date.now();
  for (let i = 0; i < 50; i++) {
    motion.onMotionMessage({ type: 'motion', from: 'spammer', s: [[now + 86_400_000 + i, 1.0]] });
  }
  // Nothing usable arrived, so the id is known but has no series: the line names the player and
  // the check has no data rather than the history having grown by 50.
  assert.match(motion.motionDebugLine(0, []), /from Spam:0/, 'fifty future samples, none kept');
  motion.onMotionMessage({ type: 'motion', from: 'spammer', s: [[now, 1.0]] });
  assert.match(motion.motionDebugLine(0, []), /from Spam:1/, 'and the in-window one is');
  motion.stopMotion();
});

test('a message that is not motion is ignored rather than breaking the handler', () => {
  // net.js routes every message no screen claims through here, so this has to be a no-op for
  // anything else - including a shape with no `from` at all.
  for (const msg of [undefined, null, {}, { type: 'whatever' }, { type: 'motion' }]) {
    assert.doesNotThrow(() => motion.onMotionMessage(msg), JSON.stringify(msg));
    // ...and the debug line has to survive whatever that left behind, which is where the real
    // failure was: a `motion` message with no `from` was filed under the key `undefined`, and
    // onMotionMessage itself returned perfectly happily. The crash came later, rendering that
    // key as a player name. Asserting only doesNotThrow on the call above tested nothing.
    // (Observed: deleting the sender guard survived until this line was added.)
    assert.doesNotThrow(() => motion.motionDebugLine(0, []), `debug line after ${JSON.stringify(msg)}`);
  }
  assert.match(motion.motionDebugLine(0, []), /from nobody/, 'and none of them counts as a sharer');
});

test('the panning threshold is what decides the ego flag, at the value the sensor actually uses', () => {
  // PANNING_DEG_PER_S masks bins where this phone was turning too fast for image motion to mean
  // anything. Nothing used to exercise it: the pan test in motion.test.js builds the ego series by
  // hand, so the constant itself was unasserted - which is how the docs came to say 10 while the
  // code said 25 without anything noticing.
  //
  // The threshold is NOT read from the module here. A test that imported it would pass at any
  // value, including the 10 the docs claimed, which is the whole failure being guarded against.
  const realNow = Date.now;
  let clock = 2_000_000;
  Date.now = () => clock;
  try {
    const flagFor = (turning) => {
      const sensor = new MotionSensor();
      sensor.start();
      const fire = () => (dom.windowListeners.get('devicemotion') ?? []).at(-1)({
        acceleration: { x: 1, y: 0, z: 0 },
        rotationRate: { alpha: turning, beta: 0, gamma: 0 },
      });
      fire();
      clock += 150; // crosses the bin boundary, closing the bin above
      fire();
      sensor.stop();
      return sensor.ego.at(-1).v;
    };

    assert.equal(flagFor(5), 0, 'a steady hand is not panning');
    assert.equal(flagFor(20), 0, 'nor are the small corrections of aiming - this is why 10 was wrong');
    assert.equal(flagFor(40), 1, 'swinging the camera to follow somebody is');
  } finally {
    Date.now = realNow;
  }
});
