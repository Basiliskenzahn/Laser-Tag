// Confirming who a tracked person is with phone motion - the identity provider installed when
// the page is opened with ?motion=on or ?motion=strict.
//
// identify.js matches body appearance and proposes a name (appearance-identity.js turns that into
// a classifier opinion). Separately, every phone shares how much it is being moved
// (motion/sensor.js) and motion/matching.js checks whose phone rises and falls with the person the
// camera is watching. resolveIdentity() fuses the two. All of the motion plumbing - the sensor,
// the permission prompt, the outgoing samples, the per-player and per-track history - is
// deliberately sealed in this one file behind the provider exported at the bottom, so nothing
// else in the app has to know motion exists. identity.js is where it gets installed, and the only
// place that mentions it.

import { fuseMotion, motionCheck, visualActivity } from './motion/matching.js';
import { MotionSensor } from './motion/sensor.js';
import { REQUIRE_MOTION } from './env.js';
import { classifierOpinion } from './appearance-identity.js';
import { send } from './net.js';
import { gamePlayer, localSelfId } from './roster.js';
import { state } from './state.js';

const MOTION_SEND_INTERVAL_MS = 500;
const MOTION_CHECK_MS = 300;
const MOTION_HISTORY_MS = 12_000;

// Everything motion knows, private to this file. It is deliberately not on the shared `state`
// object: nothing outside here can reach it, and with the provider uninstalled none of it exists.
let sensor = null; // this phone's motion sensor (motion/sensor.js), once permitted
let permissionPending = false;
const remoteActivity = new Map(); // playerId -> [{ t, v }] activity reported by that player's phone
const trackBoxes = new WeakMap(); // track -> [{ t, box }] where the camera saw that person
const trackChecks = new WeakMap(); // track -> { at, checks } the last motionChecks() for that track

function startMotion() {
  if (sensor || permissionPending) return;
  permissionPending = true;
  MotionSensor.requestPermission().then((granted) => {
    permissionPending = false;
    if (!granted) return;
    sensor = new MotionSensor();
    sensor.start();
    setInterval(flushMotion, MOTION_SEND_INTERVAL_MS);
  });
}

function flushMotion() {
  const samples = sensor?.takeOutgoing() ?? [];
  if (samples.length && state.myId) send({ type: 'motion', s: samples });
}

function onRemoteMotion(playerId, samples) {
  const list = remoteActivity.get(playerId) ?? [];
  for (const [t, v] of samples) if (Number.isFinite(t) && Number.isFinite(v)) list.push({ t, v });
  list.sort((a, b) => a.t - b.t);
  const cutoff = Date.now() - MOTION_HISTORY_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  remoteActivity.set(playerId, list);
}

function recordTrackMotion(tracks, seenAt) {
  const now = Date.now();
  for (const track of tracks) {
    if (track.lastSeen !== seenAt) continue;
    const list = trackBoxes.get(track) ?? [];
    list.push({ t: now, box: { ...track.box } });
    while (list.length && list[0].t < now - MOTION_HISTORY_MS) list.shift();
    trackBoxes.set(track, list);
  }
}

// How this person's on-screen motion matches each player's phone.
function motionChecks(track) {
  const observations = trackBoxes.get(track);
  if (!observations || observations.length < 5) return {};
  const visual = visualActivity(observations);
  const now = Date.now();
  const checks = {};
  for (const [playerId, remote] of remoteActivity) {
    if (playerId !== localSelfId()) checks[playerId] = motionCheck({ visual, remote, ego: sensor?.ego ?? [], now });
  }
  return checks;
}

// Correlating the series is the expensive part of a frame, and the loop, the hit test and the
// overlay all ask who the same track is; a track's checks are reused for MOTION_CHECK_MS.
function checksFor(track, now) {
  const cached = trackChecks.get(track);
  if (cached && now - cached.at < MOTION_CHECK_MS) return cached.checks;
  const checks = motionChecks(track);
  trackChecks.set(track, { at: now, checks });
  return checks;
}

// Who a tracked person is: the classifier's identification, confirmed or vetoed by motion.
//
// Be aware of what fuseMotion() is allowed to do here, because it decides whether a shot lands:
// when a player's phone motion is judged *inconsistent* with the person under the crosshair it
// either vetoes a correct, classifier-confident identification - the shot then silently does not
// register - or retargets the shot to a different candidate on motion correlation alone. Both
// verdicts rest on correlating accelerometer streams from separate phones, so ordinary field
// conditions that the matching tests do not simulate (clock drift between phones, a phone in a
// pocket rather than held, a backgrounded tab throttling its sensor) can produce them from noise
// alone. Motion is off unless explicitly enabled, in which case this provider is never installed
// and the whole mechanism - sensor permission prompts, outgoing samples, remote motion history -
// is out of the loop (identity.js).
//
// `confirmedBy`/`vetoedBy` name the signal for the overlay's label, so the game screen can say
// what happened without knowing that it was motion.
function resolveIdentity(track, now = performance.now()) {
  const opponents = (state.game?.players ?? [])
    .filter((p) => p.id !== localSelfId())
    .map((p) => ({ id: p.id, name: p.name, alive: p.alive !== false }));
  const id = fuseMotion({ classifier: classifierOpinion(track, now), opponents, checks: checksFor(track, now), requireMotion: REQUIRE_MOTION });
  if (id.source === 'both') return { ...id, confirmedBy: 'moves' };
  if (id.reason === 'vetoed') return { ...id, vetoedBy: 'motion' };
  return id;
}

// The debug overlay's motion line: this phone's sensor, who is sharing, and what the matching
// made of each person on screen. `liveTracks` is the loop's already-filtered list.
function motionDebugLine(now, liveTracks) {
  const status = sensor ? (sensor.receiving ? 'on' : 'no data') : 'off';
  const players = [...remoteActivity.keys()].map((id) => gamePlayer(id)?.name ?? id.slice(0, 4));
  const tracks = liveTracks.map((t) => {
    const id = resolveIdentity(t, now);
    const corr = Object.entries(trackChecks.get(t)?.checks ?? {})
      .map(([pid, c]) => `${gamePlayer(pid)?.name ?? '?'}:${c.correlation == null ? c.reason : c.correlation.toFixed(2)}`)
      .join(',');
    return `#${t.id} ${id.name ?? '-'} ${id.reason}${corr ? ` [${corr}]` : ''}`;
  });
  return `motion ${status}${REQUIRE_MOTION ? ' strict' : ''} · from ${players.join(',') || 'nobody'}${tracks.length ? `\nMotion ${tracks.join(' | ')}` : ''}`;
}

// The seal: identity.js installs this, and nothing else in the app imports this file.
export const motionIdentity = {
  start: startMotion,
  observe: recordTrackMotion,
  resolve: resolveIdentity,
  debugLine: motionDebugLine,
  onServerMessage(msg) {
    if (msg.type === 'motion') onRemoteMotion(msg.from, msg.s ?? []);
  },
};
