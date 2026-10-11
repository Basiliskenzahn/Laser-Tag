// This phone's motion, from its accelerometer and gyroscope (DeviceMotion events).
//
//   await MotionSensor.requestPermission();  // iOS asks once; call it inside a tap handler
//   const sensor = new MotionSensor(); sensor.start();
//   sensor.takeOutgoing()   // [[t, activity], ...] new since the last call, to share with the others
//   sensor.ego              // [{ t, v }] v = 1 while this phone turns too fast to trust its camera image
//
// "Activity" is how hard the phone is being moved: the RMS of its linear acceleration (gravity
// removed) over each 100 ms, in m/s^2. Walking or dodging shows up clearly; holding it to aim
// barely does. Times are Date.now() so they line up across phones, which assumes the two phones'
// system clocks agree to well inside the matching's +-400 ms search. That assumption has never
// been checked on two real phones (see the header of matching.js).

import { SAMPLE_MS } from './matching.js';

// The shooter's own turning (deg/s) above which camera-image motion isn't trusted: following a
// target with the camera hides their movement.
//
// 25, and 25 is what it has always been. Both the old identification doc and the old
// configuration table said 10, which was wrong in the direction that matters: at 10 deg/s the
// small corrections of an ordinary hand-held phone exceed the threshold, so most bins get masked
// out and motion almost never has enough usable window to say anything. Real panning to follow
// someone across a room is faster than 25.
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
    if (this.onMotion) return; // idempotent: never two listeners for one sensor
    this.onMotion = (event) => this.handle(event);
    window.addEventListener('devicemotion', this.onMotion);
  }

  // Idempotent, and safe on a sensor that was never started: the leave path calls it without
  // being able to know how far a permission prompt got.
  stop() {
    if (!this.onMotion) return;
    window.removeEventListener('devicemotion', this.onMotion);
    this.onMotion = null;
    this.bin = null; // a stopped sensor must not flush a half-filled bin into `outgoing`
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
