// This phone's motion, from its accelerometer and gyroscope (DeviceMotion events).
//
//   await MotionSensor.requestPermission();  // iOS asks once; call it inside a tap handler
//   const sensor = new MotionSensor(); sensor.start();
//   sensor.takeOutgoing()   // [[t, activity], ...] new since the last call, to share with the others
//   sensor.ego              // [{ t, v }] v = 1 while this phone turns too fast to trust its camera image
//
// "Activity" is how hard the phone is being moved: the RMS of its linear acceleration (gravity
// removed) over each 100 ms, in m/s^2. Walking or dodging shows up clearly; holding it to aim
// barely does. Times are Date.now() so they line up across phones (system clocks are kept in sync
// over the network to well under the matching's +-400 ms tolerance).

import { SAMPLE_MS } from './matching.js';

// The shooter's own turning (deg/s) above which camera-image motion isn't trusted: following a
// target with the camera hides their movement. 10 deg/s masked most of a hand-held phone's time
// (small aiming corrections exceed it), so motion almost never got to decide; real panning to
// follow someone is faster than this.
const PANNING_DEG_PER_S = 25;
const HISTORY_MS = 12_000;

export class MotionSensor {
  // Must run in a user gesture on iOS. Resolves to whether motion data is available.
  static async requestPermission() {
    if (typeof DeviceMotionEvent === 'undefined') return false;
    if (typeof DeviceMotionEvent.requestPermission !== 'function') return true;
    try {
      return (await DeviceMotionEvent.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  constructor() {
    this.activity = []; // [{ t, v }]
    this.ego = []; // [{ t, v }]
    this.outgoing = [];
    this.bin = null;
    this.gravity = null;
    this.events = 0;
  }

  start() {
    this.onMotion = (event) => this.handle(event);
    window.addEventListener('devicemotion', this.onMotion);
  }

  stop() {
    window.removeEventListener('devicemotion', this.onMotion);
  }

  get receiving() {
    return this.events > 0;
  }

  handle(event) {
    this.events++;
    const now = Date.now();
    let a = event.acceleration;
    if (!a || a.x == null) {
      // No gravity-free acceleration on this device: remove gravity with a slow low-pass filter.
      const g = event.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      this.gravity = this.gravity
        ? { x: 0.9 * this.gravity.x + 0.1 * g.x, y: 0.9 * this.gravity.y + 0.1 * g.y, z: 0.9 * this.gravity.z + 0.1 * g.z }
        : { x: g.x, y: g.y, z: g.z };
      a = { x: g.x - this.gravity.x, y: g.y - this.gravity.y, z: g.z - this.gravity.z };
    }
    const r = event.rotationRate ?? {};
    const turning = Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0);

    const binEnd = Math.ceil(now / SAMPLE_MS) * SAMPLE_MS;
    if (this.bin && this.bin.end !== binEnd) this.flush();
    this.bin ??= { end: binEnd, sumSquares: 0, count: 0, maxTurning: 0 };
    this.bin.sumSquares += a.x * a.x + a.y * a.y + a.z * a.z;
    this.bin.count++;
    this.bin.maxTurning = Math.max(this.bin.maxTurning, turning);
  }

  flush() {
    const { end, sumSquares, count, maxTurning } = this.bin;
    this.bin = null;
    const v = Math.round(Math.sqrt(sumSquares / count) * 100) / 100;
    this.activity.push({ t: end, v });
    this.ego.push({ t: end, v: maxTurning > PANNING_DEG_PER_S ? 1 : 0 });
    this.outgoing.push([end, v]);
    const cutoff = end - HISTORY_MS;
    while (this.activity.length && this.activity[0].t < cutoff) this.activity.shift();
    while (this.ego.length && this.ego[0].t < cutoff) this.ego.shift();
  }

  takeOutgoing() {
    return this.outgoing.splice(0);
  }
}
