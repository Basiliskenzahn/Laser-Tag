// Motion matching: is the person in view moving the way a player's phone says that player moves?
//
// Every phone condenses its accelerometer into an "activity" level (how much it is being moved,
// sampled 10x a second) and shares it. For each person the camera tracks, the shooter's phone
// measures the same kind of activity from the image: how fast their box moves, in box heights
// per second, which doesn't depend on how far away they are. A player and the person on screen
// are the same if their activity rises and falls together. Bystanders move independently of
// every player's phone.
//
// Pure functions, no browser APIs: used by app.js and tested in Node.

export const SAMPLE_MS = 100; // both activity series are compared on a 10 Hz grid

const DEFAULTS = {
  // In simulation (random walk/stand patterns, detector jitter), a 6 s window with a 0.75
  // threshold matched the real player every time and a bystander in ~1% of cases; 4 s windows
  // let 10-20% of bystanders match by coincidence.
  windowMs: 6000, // how much history to correlate
  maxLagMs: 400, // tolerated clock offset between phones (search range)
  minValidFraction: 0.6, // share of the window that must be usable (shooter not panning, data present)
  minVisualSpread: 0.08, // box heights/s: the person must actually move during the window
  minRemoteSpread: 0.25, // m/s^2: the player's phone must actually move
  consistentAt: 0.75, // correlation from which the motion confirms the identity
  inconsistentAt: 0.3, // at or below this an active pair contradicts it (simulation: 60% of bystanders, no players)
};

// Values of a time series ({ t, v } sorted by t) on the 10 Hz grid ending at `end`, by linear
// interpolation; null where there's no data within `gapMs`.
export function resample(series, end, windowMs, gapMs = 350) {
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
export function visualActivity(observations) {
  const out = [];
  for (let i = 1; i < observations.length; i++) {
    const a = observations[i - 1];
    const b = observations[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0 || dt > 0.6) continue;
    const h = (a.box.h + b.box.h) / 2;
    const dx = b.box.x + b.box.w / 2 - (a.box.x + a.box.w / 2);
    const dy = b.box.y + b.box.h / 2 - (a.box.y + a.box.h / 2);
    out.push({ t: (a.t + b.t) / 2, v: Math.hypot(dx, dy) / h / dt });
  }
  return out;
}

// How well a tracked person's motion matches one player's phone.
//   visual: [{ t, v }] activity of the person (visualActivity)
//   remote: [{ t, v }] activity reported by the player's phone (m/s^2), same clock (Date.now)
//   ego:    [{ t, v }] 1 when the shooter's own phone was turning too fast to trust the image
// Returns { status: 'consistent' | 'inconsistent' | 'unknown', correlation, lagMs, reason }.
export function motionCheck({ visual, remote, ego = [], now, ...options }) {
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

// The appearance classifier and motion together (same rules as for sonar distances):
//
//   classifier names P, P's phone moves with the person   -> P, confirmed by both
//   classifier names P, no usable motion                 -> P if the classifier is confident on its own
//   classifier names P, P's phone clearly doesn't match  -> vetoed (a bystander who looks like P),
//                                                          unless another candidate matches
//   classifier names nobody, exactly one phone matches   -> that player (motion alone)
//
// classifier: { playerId, name, confident, candidates, self }; checks: { [playerId]: motionCheck() }.
// Returns { playerId, name, verified, source: 'both' | 'classifier' | 'motion', reason }.
export function fuseMotion({ classifier = {}, opponents, checks, requireMotion = false }) {
  if (classifier.self) return { playerId: null, reason: 'self' };
  const alive = opponents.filter((p) => p.alive !== false);
  const check = (id) => checks[id] ?? { status: 'unknown' };
  const proposed = classifier.playerId ? alive.find((p) => p.id === classifier.playerId) : null;

  if (proposed) {
    const c = check(proposed.id);
    const result = { playerId: proposed.id, name: proposed.name, motion: c };
    if (c.status === 'consistent') return { ...result, verified: true, source: 'both', reason: 'confirmed' };
    if (c.status === 'unknown') {
      return classifier.confident && !requireMotion
        ? { ...result, verified: false, source: 'classifier', reason: 'classifier-only' }
        : { playerId: null, reason: 'unconfirmed', motion: c };
    }
    const alternatives = alive
      .filter((p) => p.id !== proposed.id && (classifier.candidates ?? []).includes(p.id) && check(p.id).status === 'consistent')
      .sort((a, b) => check(b.id).correlation - check(a.id).correlation);
    if (alternatives.length === 1) {
      return { playerId: alternatives[0].id, name: alternatives[0].name, verified: true, source: 'both', reason: 'corrected', motion: check(alternatives[0].id) };
    }
    return { playerId: null, reason: 'vetoed', vetoed: proposed.id, motion: c };
  }

  const matching = alive.filter((p) => check(p.id).status === 'consistent');
  if (matching.length === 1) {
    return { playerId: matching[0].id, name: matching[0].name, verified: true, source: 'motion', reason: 'motion-only', motion: check(matching[0].id) };
  }
  return { playerId: null, reason: matching.length ? 'ambiguous' : 'unrecognised' };
}
