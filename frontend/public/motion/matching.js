// Motion matching: is the person in view moving the way a player's phone says that player moves?
//
// Every phone condenses its accelerometer into an "activity" level (how much it is being moved,
// sampled 10x a second) and shares it. For each person the camera tracks, the shooter's phone
// measures the same kind of activity from the image: how fast their box moves, in box heights
// per second, which doesn't depend on how far away they are. A player and the person on screen
// should be the same if their activity rises and falls together, and unrelated for a bystander.
//
// SHOULD. Read the next paragraph before you trust a number out of this file.
//
// UNVALIDATED. Every accuracy figure ever recorded for this module came from a synthetic
// random-walk simulation (test/motion.test.js): a scripted stand/walk pattern turned into a
// clean 10 Hz activity series and a box sliding across a frame with uniform jitter. No part of
// it has ever been compared against a real accelerometer in a real room. The simulation cannot
// produce the things that actually break correlation in the field - a phone in a pocket or a
// swinging hand rather than held out, clock drift between two phones beyond the +-400 ms the
// search covers, a backgrounded tab whose sensor is throttled to a fraction of 10 Hz, two
// players walking in step, or a bystander who happens to pace the room like a player does. The
// thresholds below are therefore guesses that survived a simulation, not measurements. Nothing
// in this file may decide a shot on its own, and target.js is where that is enforced.
//
// This signal is orthogonal to appearance, so it is never blended into the appearance score: at
// most it confirms an identity appearance already arrived at. The decision rules live in
// target.js; this file is only the correlation maths, and it has no browser APIs so all of it is
// unit-tested in Node (test/motion.test.js).

export const SAMPLE_MS = 100; // both activity series are compared on a 10 Hz grid

// Boxes thinner than this are not a person whose movement can be measured: a box a handful of
// pixels high has a centre made almost entirely of detector jitter, so "box heights per second"
// off it is noise divided by noise - and at h = 0 it is a division by zero that puts Infinity
// (then NaN, through pearson) into the correlation.
//
// 8 px is deliberately the same floor poseBoxes() applies in detector.js. That filter is the
// reason this guard was once thought unnecessary: the old documentation claimed
// detectTrackedPeople() dropped boxes under 8 px, but the filter is on the pose boxes only -
// every box from the object detector reaches the tracker, and so reaches here, unfiltered.
const MIN_BOX_H = 8;

const DEFAULTS = {
  // SIMULATED, not measured (see the header): in the random-walk simulation a 6 s window at a
  // 0.75 threshold matched the scripted player on every seed and a scripted bystander in ~1% of
  // runs, where 4 s windows let 10-20% of bystanders match by coincidence. That is a statement
  // about the simulation's noise model and nothing else.
  windowMs: 6000, // how much history to correlate
  maxLagMs: 400, // tolerated clock offset between phones (search range)
  minValidFraction: 0.6, // share of the window that must be usable (shooter not panning, data present)
  minVisualSpread: 0.08, // box heights/s: the person must actually move during the window
  minRemoteSpread: 0.25, // m/s^2: the player's phone must actually move
  consistentAt: 0.75, // correlation from which the motion confirms the identity
  inconsistentAt: 0.3, // at or below this an active pair contradicts it
};

// Values of a time series ({ t, v } sorted by t) on the 10 Hz grid ending at `end`, by linear
// interpolation; null where there's no data within `gapMs`.
export function resample(series = [], end, windowMs, gapMs = 350) {
  const n = Math.round(windowMs / SAMPLE_MS);
  const out = new Array(n).fill(null);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = end - (n - 1 - k) * SAMPLE_MS;
    while (j < series.length - 1 && series[j + 1].t <= t) j++;
    const a = series[j];
    const b = series[j + 1];
    if (!a) continue;
    if (a.t <= t && b && b.t >= t && b.t - a.t <= gapMs) {
      out[k] = b.t === a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    } else if (Math.abs(a.t - t) <= gapMs / 2) {
      out[k] = a.v;
    }
  }
  return out;
}

function spread(values) {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

// Box observations of one tracked person ([{ t, box }]) -> its activity series ([{ t, v }]):
// how fast the box centre moves, in box heights per second.
//
// Pairs whose box is too small to measure, or whose numbers are not finite, are skipped rather
// than producing an Infinity the correlation cannot recover from - see MIN_BOX_H.
export function visualActivity(observations = []) {
  const out = [];
  for (let i = 1; i < observations.length; i++) {
    const a = observations[i - 1];
    const b = observations[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0 || dt > 0.6) continue;
    const h = (a.box.h + b.box.h) / 2;
    if (!(h >= MIN_BOX_H)) continue; // also rejects NaN and a negative height
    const dx = b.box.x + b.box.w / 2 - (a.box.x + a.box.w / 2);
    const dy = b.box.y + b.box.h / 2 - (a.box.y + a.box.h / 2);
    const v = Math.hypot(dx, dy) / h / dt;
    if (!Number.isFinite(v)) continue; // a non-finite coordinate anywhere in the pair
    out.push({ t: (a.t + b.t) / 2, v });
  }
  return out;
}

// How well a tracked person's motion matches one player's phone.
//   visual: [{ t, v }] activity of the person (visualActivity)
//   remote: [{ t, v }] activity reported by the player's phone (m/s^2), same clock (Date.now)
//   ego:    [{ t, v }] 1 when the shooter's own phone was turning too fast to trust the image
//
// Returns { status: 'consistent' | 'inconsistent' | 'unknown', correlation, lagMs, reason }.
// 'unknown' is the answer whenever the data cannot support one, and it is by far the most common
// answer in practice: two people standing still produce no usable correlation at all.
//
// Every series defaults to empty. A partial call used to throw out of resample() on
// `series.length`, which made a caller that forgot an argument fail as a crash in the frame loop
// rather than as 'unknown'.
export function motionCheck({ visual = [], remote = [], ego = [], now, ...options }) {
  const o = { ...DEFAULTS, ...options };
  const pad = o.maxLagMs;
  const v = resample(visual, now, o.windowMs);
  const panning = resample(ego, now, o.windowMs);
  let best = { correlation: -Infinity, lagMs: 0, used: 0 };
  for (let lag = -pad; lag <= pad; lag += SAMPLE_MS) {
    // The remote phone's clock may be off by `lag`: compare against its series shifted back.
    const r = resample(remote, now + lag, o.windowMs);
    const xs = [];
    const ys = [];
    for (let i = 0; i < v.length; i++) {
      if (v[i] == null || r[i] == null || (panning[i] ?? 0) > 0.5) continue;
      xs.push(v[i]);
      ys.push(r[i]);
    }
    if (xs.length < o.minValidFraction * v.length) continue;
    const c = pearson(xs, ys);
    if (c > best.correlation) best = { correlation: c, lagMs: lag, used: xs.length, xs, ys };
  }
  if (!best.used) return { status: 'unknown', reason: 'not enough data' };
  if (spread(best.xs) < o.minVisualSpread) return { status: 'unknown', reason: 'person not moving', correlation: best.correlation };
  if (spread(best.ys) < o.minRemoteSpread) return { status: 'unknown', reason: 'phone not moving', correlation: best.correlation };
  const status = best.correlation >= o.consistentAt ? 'consistent' : best.correlation <= o.inconsistentAt ? 'inconsistent' : 'unknown';
  return { status, correlation: best.correlation, lagMs: best.lagMs, reason: status === 'unknown' ? 'unclear' : '' };
}
