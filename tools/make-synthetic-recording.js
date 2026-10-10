// Write the synthetic example recording in test/fixtures/, for tools/motion-replay.js.
//
//   node tools/make-synthetic-recording.js            # rewrites the committed fixture
//   node tools/make-synthetic-recording.js out.json
//
// THIS IS NOT MEASURED DATA. No phone was involved. It exists because a replay harness with no
// recording to replay cannot be run, reviewed or regression-tested, and a real recording needs
// three phones and three people in a room. Every number it produces is a statement about the
// simulation below, not about real accelerometers - see docs/motion-capture.md for the list of
// questions only a real recording can answer.
//
// What it does simulate, which the simulation in test/motion.test.js does not:
//
//   * three separate phone clocks, one of them 180 ms fast, so the lag search is exercised;
//   * motion arriving in 500 ms batches over a network with varying latency, rather than as a
//     complete series - which is what the matcher actually sees;
//   * the shooter panning the camera twice, dragging every box across the frame with it;
//   * the client's own rolling buffers (boxes, remote samples, ego flags) and its 300 ms check
//     throttle, so the recorded verdicts come from the state the live client would have had;
//   * an appearance classifier that is wrong about one person, so the fusion table's "corrected"
//     branch appears in the output.
//
// Deterministic: seeded RNG, a fixed start timestamp, no clock reads. Running it twice produces
// byte-identical output.

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { motionCheck, visualActivity } from '../frontend/public/motion/matching.js';

const T0 = Date.UTC(2026, 9, 10, 14, 30, 0); // fixed, so the fixture never churns
const DURATION_MS = 24_000;
const BIN_MS = 100; // motion/sensor.js bins activity at 10 Hz
const FLUSH_MS = 500; // motion-identity.js MOTION_SEND_INTERVAL_MS
const CHECK_MS = 300; // motion-identity.js MOTION_CHECK_MS
const HISTORY_MS = 12_000; // motion-identity.js MOTION_HISTORY_MS
const FRAME_MS = 140; // ~7 detections per second

const ME = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Vince' };
const REX = { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Rex' };
const KAI = { id: 'cccccccc-0000-4000-8000-000000000003', name: 'Kai' };

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

// A person alternating between standing (aiming) and moving (walking, dodging), as in
// test/motion.test.js - the generator this one is grown from.
function schedule(seconds, seed) {
  const random = rng(seed);
  const segments = [];
  for (let t = 0, moving = random() < 0.5; t < seconds; moving = !moving) {
    const length = moving ? 0.6 + random() * 1.6 : 0.5 + random() * 1.5;
    segments.push({ from: t, to: t + length, moving });
    t += length;
  }
  return (t) => segments.find((s) => t >= s.from && t < s.to)?.moving ?? false;
}

// The shooter swings the camera twice. Both episodes also drag every box across the frame, which
// is the corruption the ego mask exists to suppress.
const PANS = [
  { from: 7000, to: 7600, pixels: 170 },
  { from: 15200, to: 15500, pixels: -90 },
];
const panningAt = (ms) => PANS.some((pan) => ms >= pan.from && ms < pan.to);
const panOffsetAt = (ms) => {
  let offset = 0;
  for (const pan of PANS) offset += pan.pixels * Math.min(1, Math.max(0, (ms - pan.from) / (pan.to - pan.from)));
  return offset;
};

// One phone's 10 Hz activity bins, on its own clock. `offsetMs` is how far that clock runs ahead
// of the shooter's: the bin boundaries follow the phone's clock, so the true interval each bin
// covers is shifted by the same amount. `producedAt` is when the bin existed in real time, which
// is what decides which network flush carries it. Values are rounded to 2 dp, as sensor.js does.
function phoneBins({ moving, offsetMs, seed, still = 0.15, active = 1.8, noise = 0.25 }) {
  const random = rng(seed);
  const bins = [];
  for (let end = BIN_MS; end <= DURATION_MS + offsetMs; end += BIN_MS) {
    const trueMid = end - BIN_MS / 2 - offsetMs;
    if (trueMid < 0) continue;
    const v = (moving(trueMid / 1000) ? active : still) + noise * random();
    bins.push({ t: T0 + end, producedAt: T0 + end - offsetMs, v: Math.round(v * 100) / 100 });
  }
  return bins;
}

// Everything one phone ever puts on the wire: 500 ms batches, each delayed by its own latency.
function relayMessages(player, bins, seed) {
  const latency = rng(seed);
  const messages = [];
  let sent = 0;
  for (let flush = FLUSH_MS; sent < bins.length; flush += FLUSH_MS) {
    const ready = [];
    while (sent < bins.length && bins[sent].producedAt <= T0 + flush) ready.push(bins[sent++]);
    if (!ready.length) continue;
    messages.push({
      at: T0 + flush + Math.round(60 + 180 * latency()),
      from: player.id,
      s: ready.map((bin) => [bin.t, bin.v]),
    });
  }
  return messages;
}

// A person's box: walking sideways at 0.6 body heights/s, plus detector jitter, plus whatever the
// shooter's panning is doing to the whole frame.
function boxTrack({ moving, seed, h, x0 }) {
  const random = rng(seed);
  let x = x0;
  let direction = seed % 2 ? 1 : -1;
  let last = 0;
  return (ms) => {
    const dt = (ms - last) / 1000;
    last = ms;
    if (moving(ms / 1000)) x += direction * 0.6 * h * dt;
    if (x > 900 || x < 100) direction = -direction;
    const jitter = () => (random() - 0.5) * 0.03 * h;
    return { x: x + panOffsetAt(ms) + jitter(), y: 110 + jitter(), w: h / 3, h: h + jitter() };
  };
}

// Frame times for a ~7 Hz detector with a bit of scheduling jitter.
function frameTimes() {
  const jitter = rng(401);
  const times = [];
  for (let t = 0; t < DURATION_MS; t += FRAME_MS * (0.85 + 0.3 * jitter())) times.push(T0 + Math.round(t));
  return times;
}

export function buildRecording() {
  const seconds = DURATION_MS / 1000;
  const moving = {
    rex: schedule(seconds, 11),
    kai: schedule(seconds, 23),
    bystander: schedule(seconds, 37),
  };
  const shooterMoving = (t) => panningAt(t * 1000);

  // Kai's phone clock is 180 ms fast: inside the matcher's +-400 ms search range, but only
  // because the search exists.
  const rexBins = phoneBins({ moving: moving.rex, offsetMs: 0, seed: 101 });
  const kaiBins = phoneBins({ moving: moving.kai, offsetMs: 180, seed: 102 });
  // The shooter is holding the phone to aim: barely any activity, except while panning.
  const ownBins = phoneBins({ moving: shooterMoving, offsetMs: 0, seed: 103, still: 0.12, active: 0.9, noise: 0.18 });
  const egoBins = ownBins.map((bin) => ({ t: bin.t, v: panningAt(bin.t - T0) ? 1 : 0 }));

  const inbox = [...relayMessages(REX, rexBins, 201), ...relayMessages(KAI, kaiBins, 202)].sort((a, b) => a.at - b.at || a.from.localeCompare(b.from));

  const people = [
    { trackId: 1, truth: REX.id, box: boxTrack({ moving: moving.rex, seed: 301, h: 300, x0: 240 }) },
    { trackId: 2, truth: KAI.id, box: boxTrack({ moving: moving.kai, seed: 302, h: 260, x0: 560 }) },
    { trackId: 3, truth: 'bystander', box: boxTrack({ moving: moving.bystander, seed: 303, h: 330, x0: 760 }) },
  ];

  // The appearance classifier, as the recording stores it. Deliberately wrong about track 2: it
  // reads Kai as Rex but lists both as candidates, which is the case motion is there to fix.
  const classifierFor = {
    1: { playerId: REX.id, name: REX.name, confident: true, self: false, candidates: [REX.id, KAI.id] },
    2: { playerId: REX.id, name: REX.name, confident: true, self: false, candidates: [REX.id, KAI.id] },
    3: { playerId: null, name: null, confident: false, self: false, candidates: [] },
  };

  const recording = {
    format: 'laser-tag-motion-session',
    version: 1,
    synthetic: true,
    note: 'Generated by tools/make-synthetic-recording.js - simulated phones, no measured data.',
    recordedAt: T0,
    endedAt: T0 + DURATION_MS,
    userAgent: 'synthetic/1.0 (no device)',
    room: 'synth',
    flags: { requireMotion: false }, // as if recorded with ?motion=on&record, not strict

    self: { playerId: ME.id, name: ME.name },
    players: [ME, REX, KAI].map(({ id, name }) => ({ id, name })),
    aliveChanges: [REX, KAI].map(({ id }) => ({ t: T0, id, alive: true })),
    own: { activity: [], ego: [] },
    remote: [],
    tracks: people.map((person) => ({ id: person.trackId, observations: [], classifier: [], liveChecks: [] })),
    truth: Object.fromEntries(people.map((person) => [String(person.trackId), person.truth])),
  };
  const byId = new Map(recording.tracks.map((track) => [track.id, track]));

  // Live client state, kept here the way the browser keeps it, so the recorded verdicts are the
  // ones the client would really have reached - and so motion-replay.js's independent
  // reconstruction of this state has something to be checked against.
  const trackMotion = new Map(people.map((person) => [person.trackId, []])); // [{ t, box }]
  const remoteMotion = new Map(); // playerId -> [{ t, v }]
  const egoBuffer = [];
  const lastCheck = new Map();
  let nextEgo = 0;
  let nextOwn = 0;
  let delivered = 0;

  for (const now of frameTimes()) {
    // flushMotion() every 500 ms; the recorder notes exactly what was shared.
    while (nextOwn < ownBins.length && ownBins[nextOwn].t <= Math.floor((now - T0) / FLUSH_MS) * FLUSH_MS + T0) {
      recording.own.activity.push([ownBins[nextOwn].t, ownBins[nextOwn].v]);
      nextOwn++;
    }

    // onRemoteMotion(), verbatim, for every relay that has arrived.
    while (delivered < inbox.length && inbox[delivered].at <= now) {
      const message = inbox[delivered++];
      recording.remote.push(message);
      const list = remoteMotion.get(message.from) ?? [];
      for (const [t, v] of message.s) if (Number.isFinite(t) && Number.isFinite(v)) list.push({ t, v });
      list.sort((a, b) => a.t - b.t);
      const cutoff = message.at - HISTORY_MS;
      while (list.length && list[0].t < cutoff) list.shift();
      remoteMotion.set(message.from, list);
    }

    // The sensor's rolling ego buffer, and the recorder copying whatever is new out of it.
    while (nextEgo < egoBins.length && egoBins[nextEgo].t <= now) {
      egoBuffer.push(egoBins[nextEgo]);
      recording.own.ego.push([egoBins[nextEgo].t, egoBins[nextEgo].v]);
      nextEgo++;
    }
    const egoCutoff = (egoBuffer[egoBuffer.length - 1]?.t ?? 0) - HISTORY_MS;
    while (egoBuffer.length && egoBuffer[0].t < egoCutoff) egoBuffer.shift();

    // recordTrackMotion(): one box per visible person, 12 s of history.
    for (const person of people) {
      const box = person.box(now - T0);
      const list = trackMotion.get(person.trackId);
      list.push({ t: now, box });
      while (list.length && list[0].t < now - HISTORY_MS) list.shift();
      byId.get(person.trackId).observations.push([now, box.x, box.y, box.w, box.h]);
    }

    // resolveIdentity(): the classifier's opinion, and motionChecks() at most every 300 ms.
    for (const person of people) {
      const entry = byId.get(person.trackId);
      if (!entry.classifier.length) entry.classifier.push({ t: now, ...classifierFor[person.trackId] });
      if (now - (lastCheck.get(person.trackId) ?? -Infinity) < CHECK_MS) continue;
      lastCheck.set(person.trackId, now);
      const observations = trackMotion.get(person.trackId);
      const checks = {};
      if (observations.length >= 5) {
        const visual = visualActivity(observations);
        for (const [playerId, remote] of remoteMotion) {
          if (playerId === ME.id) continue;
          const check = motionCheck({ visual, remote, ego: egoBuffer, now });
          checks[playerId] = {
            status: check.status,
            ...(check.correlation == null ? {} : { correlation: check.correlation }),
            ...(check.lagMs == null ? {} : { lagMs: check.lagMs }),
            ...(check.reason ? { reason: check.reason } : {}),
          };
        }
      }
      entry.liveChecks.push({ t: now, checks });
    }
  }
  return recording;
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = argv[0] ? resolve(argv[0]) : resolve(here, '..', 'test', 'fixtures', 'motion-session-synthetic.json');
  const recording = buildRecording();
  writeFileSync(out, `${JSON.stringify(recording)}\n`);
  const observations = recording.tracks.reduce((sum, track) => sum + track.observations.length, 0);
  const checks = recording.tracks.reduce((sum, track) => sum + track.liveChecks.length, 0);
  console.log(
    `wrote ${out}\n` +
      `  ${DURATION_MS / 1000}s · ${recording.tracks.length} tracks · ${observations} box observations · ` +
      `${checks} check instants · ${recording.remote.length} relayed messages · ${recording.own.activity.length} own samples`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
