// The room's motion state: this phone's sensor, what every other phone has reported, and where
// the camera has seen each tracked person.
//
// This is the stateful half of motion matching; motion/matching.js is the pure maths and
// target.js owns the one decision anything is allowed to make from it. Everything here is
// private to this file - none of it is on the shared `state` object and none of it is written
// onto the tracker's track objects - and all of it is given back by stopMotion().
//
// There is no provider object and no seam. The subsystem this replaces installed one of two
// six-method "identity providers" at load (identity.js) so that the game loop could not tell
// which signals had answered. That indirection only earned its keep while motion could *change*
// the answer. It can no longer: with motion additive-only, who may be shot under ?motion=on is
// exactly who appearance named, so there is nothing for a second provider to return differently.
// See target.js.
//
// WHAT IS STILL NOT KNOWN: see the header of motion/matching.js. The correlation this file feeds
// has never been run against a real accelerometer.

import { MOTION_ENABLED, REQUIRE_MOTION } from '../env.js';
import { motionCheck, visualActivity } from './matching.js';
import { MotionSensor } from './sensor.js';
import { gamePlayer, localSelfId } from '../roster.js';
import { state } from '../state.js';

export const MOTION_SEND_INTERVAL_MS = 500; // how often this phone's new samples go to the room
const MOTION_CHECK_MS = 300; // how long a track's checks are reused for
const MOTION_HISTORY_MS = 12_000; // how much of either history is kept

// Private to this file, and with motion off none of it is ever written.
let sensor = null; // this phone's motion sensor, once permitted
let sendMessage = null; // net.js's send(), injected by startMotion so this file need not import it
let permissionPending = false;
let flushTimer = null; // the outgoing-sample interval, so stopMotion can clear it
let generation = 0; // bumped by stopMotion, so a permission prompt it outlived starts nothing
const remoteActivity = new Map(); // playerId -> [{ t, v }] activity reported by that player's phone
const trackBoxes = new WeakMap(); // track -> [{ t, box }] where the camera saw that person
const trackChecks = new WeakMap(); // track -> { at, checks } the last checks computed for that track
const trackLastSeen = new WeakMap(); // track -> the lastSeen already recorded, so one box per detection

// Ask for sensor permission and start sharing. Must be called from inside a tap: that is the only
// place iOS will show the prompt. `send` is net.js's send(); it is passed in rather than imported
// because net.js's own import graph reaches back into the game screen, and target.js - which
// imports this file - must not drag that in.
export function startMotion(send) {
  if (!MOTION_ENABLED || sensor || permissionPending) return;
  sendMessage = send;
  permissionPending = true;
  const attempt = generation;
  MotionSensor.requestPermission().then((granted) => {
    permissionPending = false;
    // The player may have left the room while the permission prompt was up; this attempt is over,
    // and starting a sensor now would be exactly the leak stopMotion exists to prevent.
    if (!granted || attempt !== generation) return;
    sensor = new MotionSensor();
    sensor.start();
    flushTimer = setInterval(flushMotion, MOTION_SEND_INTERVAL_MS);
  });
}

// Leaving a room gives all of this back. None of it used to be: the flush interval and the
// devicemotion listener ran for the life of the page whatever screen was showing, so a phone
// parked on the join screen kept waking its accelerometer, and remoteActivity accumulated a
// player id for everyone this phone had ever shared a room with.
//
// The per-track maps are WeakMaps keyed by the track objects, so they go when the tracker drops
// the tracks; there is nothing to clear by hand.
export function stopMotion() {
  generation++;
  permissionPending = false;
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  sensor?.stop();
  sensor = null;
  sendMessage = null;
  remoteActivity.clear();
}

function flushMotion() {
  const samples = sensor?.takeOutgoing() ?? [];
  if (samples.length && state.myId) sendMessage?.({ type: 'motion', s: samples });
}

// One relayed `motion` message. net.js hands over every message no screen claims, so this also
// has to be harmless for a message that is not ours.
//
// Samples are kept only while they are inside the history window in *both* directions. Trimming
// the old end alone was not enough to bound this list: a sample stamped far in the future never
// becomes older than the cutoff, so it is never trimmed, and one entry per message accumulates
// for as long as the room lasts. Such a sample is useless either way - it can never land inside
// the 6 s the correlation looks at - so the only question was whether it also leaked, and it did.
export function onMotionMessage(msg) {
  // `from` has to be checked, not assumed. A `motion` message with no sender - a truncated relay,
  // or any future server bug - used to be filed under the key `undefined`, and the debug line
  // then crashed calling .slice() on it while rendering that key as a player name.
  if (!MOTION_ENABLED || msg?.type !== 'motion' || typeof msg.from !== 'string' || !msg.from) return;
  const now = Date.now();
  const list = remoteActivity.get(msg.from) ?? [];
  for (const [t, v] of msg.s ?? []) {
    if (Number.isFinite(t) && Number.isFinite(v) && t > now - MOTION_HISTORY_MS && t < now + MOTION_HISTORY_MS) {
      list.push({ t, v });
    }
  }
  list.sort((a, b) => a.t - b.t);
  while (list.length && list[0].t < now - MOTION_HISTORY_MS) list.shift();
  remoteActivity.set(msg.from, list);
}

// Where the camera saw this person, at most one sample per detection.
//
// The old subsystem needed a line in the frame loop for this (`identity.observe(tracks, t0)`,
// right after the tracker ran). It does not any more: `track.lastSeen` only changes when the
// detector actually found that person, so recording the first time a new `lastSeen` is seen gives
// exactly one sample per detection, and target.js already calls into here once per live track per
// frame. That costs up to one animation frame of timestamp jitter against the detection itself -
// under 17 ms on a 100 ms grid - and buys the subsystem needing no change to screens/game.js at
// all.
export function noteTrackBox(track) {
  if (!MOTION_ENABLED || trackLastSeen.get(track) === track.lastSeen) return;
  trackLastSeen.set(track, track.lastSeen);
  const now = Date.now();
  const list = trackBoxes.get(track) ?? [];
  list.push({ t: now, box: { ...track.box } });
  while (list.length && list[0].t < now - MOTION_HISTORY_MS) list.shift();
  trackBoxes.set(track, list);
}

// How this person's on-screen motion compares with each other player's phone.
function motionChecks(track) {
  const observations = trackBoxes.get(track);
  if (!observations || observations.length < 5) return {};
  const visual = visualActivity(observations);
  const now = Date.now(); // the clock the remote series are stamped on
  const checks = {};
  for (const [playerId, remote] of remoteActivity) {
    if (playerId !== localSelfId()) checks[playerId] = motionCheck({ visual, remote, ego: sensor?.ego ?? [], now });
  }
  return checks;
}

// Correlating the series is the expensive part of a frame and the hit test and the overlay both
// ask about the same track, so a track's checks are reused for MOTION_CHECK_MS. `now` is
// performance.now(), for the cache only.
function checksFor(track, now) {
  const cached = trackChecks.get(track);
  if (cached && now - cached.at < MOTION_CHECK_MS) return cached.checks;
  const checks = motionChecks(track);
  trackChecks.set(track, { at: now, checks });
  return checks;
}

// Does motion confirm that this track is `playerId`?
//
// `confirmed` true is the only thing any caller may act on. Everything else - a contradicting
// correlation included - is reported for the debug overlay and for ?motion=strict, and may not
// be turned into "this is somebody else": this function never names a player, it only answers
// about the one it was asked about.
export function motionConfirmation(track, playerId, now) {
  if (!MOTION_ENABLED || !playerId) return { confirmed: false, status: 'off' };
  const check = checksFor(track, now)[playerId];
  if (!check) return { confirmed: false, status: 'unknown', reason: 'nothing shared' };
  return { confirmed: check.status === 'consistent', ...check };
}

// The debug overlay's motion line: this phone's sensor, who is sharing, and what the correlation
// made of each person on screen against each of them. Under ?motion=on this line is the entire
// observable effect of the subsystem, which is deliberate - it is the instrument that would let
// somebody find out whether the signal is real. `liveTracks` is the loop's already-filtered list.
export function motionDebugLine(now, liveTracks = []) {
  if (!MOTION_ENABLED) return '';
  const status = sensor ? (sensor.receiving ? 'on' : 'no data') : 'off';
  // `name:count` rather than just the name: how many samples of a player are actually in the
  // window is the first thing worth knowing in the field, and it tells a phone that is sharing
  // nothing apart from one that is sharing and simply not correlating.
  const players = [...remoteActivity].map(([id, series]) => `${gamePlayer(id)?.name ?? id.slice(0, 4)}:${series.length}`);
  const tracks = liveTracks
    .map((track) => {
      const corr = Object.entries(checksFor(track, now))
        .map(([pid, c]) => `${gamePlayer(pid)?.name ?? '?'}:${c.correlation == null ? c.reason : c.correlation.toFixed(2)}`)
        .join(',');
      return corr ? `#${track.id} [${corr}]` : '';
    })
    .filter(Boolean);
  return `motion ${status}${REQUIRE_MOTION ? ' strict' : ''} · from ${players.join(',') || 'nobody'}${tracks.length ? `\nMotion ${tracks.join(' | ')}` : ''}`;
}
