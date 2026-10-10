// Deciding who a tracked person actually is, from two independent sources.
//
// identify.js matches body appearance and proposes a name. Separately, every phone shares how
// much it is being moved (motion/sensor.js) and motion/matching.js checks whose phone rises and
// falls with the person the camera is watching. identity() fuses the two, so a confident
// look-alike can still be vetoed, and ?motion=strict insists on the motion confirmation. The
// sending and collecting of those motion samples lives here as well, since nothing else needs it.

import { fuseMotion, motionCheck, visualActivity } from './motion/matching.js';
import { MotionSensor } from './motion/sensor.js';
import { REQUIRE_MOTION } from './env.js';
import { send } from './net.js';
import { localSelfId } from './roster.js';
import { state } from './state.js';

const MOTION_SEND_INTERVAL_MS = 500;
const MOTION_CHECK_MS = 300;
const MOTION_HISTORY_MS = 12_000;
const TARGET_LOCK_MS = 350;
const TARGET_MIN_SCORE = 0.48;
const TARGET_MIN_PART = 0.22;
// Re-identification identities can also come from accumulated evidence just under the accept
// threshold (0.72, identify.js); a shot needs at least this.
const TARGET_MIN_REID_SCORE = 0.7;

export function startMotion() {
  if (state.motion || state.motionRequested) return;
  state.motionRequested = true;
  MotionSensor.requestPermission().then((granted) => {
    state.motionRequested = false;
    if (!granted) return;
    state.motion = new MotionSensor();
    state.motion.start();
    setInterval(flushMotion, MOTION_SEND_INTERVAL_MS);
  });
}

function flushMotion() {
  const samples = state.motion?.takeOutgoing() ?? [];
  if (samples.length && state.myId) send({ type: 'motion', s: samples });
}

export function onRemoteMotion(playerId, samples) {
  const list = state.remoteMotion.get(playerId) ?? [];
  for (const [t, v] of samples) if (Number.isFinite(t) && Number.isFinite(v)) list.push({ t, v });
  list.sort((a, b) => a.t - b.t);
  const cutoff = Date.now() - MOTION_HISTORY_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  state.remoteMotion.set(playerId, list);
}

export function recordTrackMotion(tracks, seenAt) {
  const now = Date.now();
  for (const track of tracks) {
    if (track.lastSeen !== seenAt) continue;
    const list = state.trackMotion.get(track) ?? [];
    list.push({ t: now, box: { ...track.box } });
    while (list.length && list[0].t < now - MOTION_HISTORY_MS) list.shift();
    state.trackMotion.set(track, list);
  }
}

// How this person's on-screen motion matches each player's phone.
function motionChecks(track) {
  const observations = state.trackMotion.get(track);
  if (!observations || observations.length < 5) return {};
  const visual = visualActivity(observations);
  const now = Date.now();
  const checks = {};
  for (const [playerId, remote] of state.remoteMotion) {
    if (playerId !== localSelfId()) checks[playerId] = motionCheck({ visual, remote, ego: state.motion?.ego ?? [], now });
  }
  return checks;
}

function isStableTarget(track, now = performance.now()) {
  // A re-identification match has already cleared its own threshold; the colour-part minimums
  // below are for the colour signature, and lighting can push them down for the right person.
  if (track.hasReid) {
    return Boolean(
      track.playerId &&
        Number.isFinite(track.identifiedAt) &&
        now - track.identifiedAt >= TARGET_LOCK_MS &&
        track.score >= TARGET_MIN_REID_SCORE,
    );
  }
  return Boolean(
    track.playerId &&
      Number.isFinite(track.identifiedAt) &&
      now - track.identifiedAt >= TARGET_LOCK_MS &&
      track.score >= TARGET_MIN_SCORE &&
      track.upper >= TARGET_MIN_PART &&
      track.lower >= TARGET_MIN_PART &&
      track.grid >= TARGET_MIN_PART,
  );
}

function classifierOpinion(track, now) {
  if (track.selfRejected || track.playerId === localSelfId()) return { self: true };
  return {
    playerId: track.playerId,
    name: track.name,
    confident: isStableTarget(track, now),
    candidates: (track.rankings ?? []).map((r) => r.id),
  };
}

// Who a tracked person is: the classifier's identification, confirmed or vetoed by motion.
export function identity(track, now = performance.now()) {
  if (!track.motionAt || now - track.motionAt >= MOTION_CHECK_MS) {
    track.motionAt = now;
    track.motionChecks = motionChecks(track);
  }
  const opponents = (state.game?.players ?? [])
    .filter((p) => p.id !== localSelfId())
    .map((p) => ({ id: p.id, name: p.name, alive: p.alive !== false }));
  return fuseMotion({ classifier: classifierOpinion(track, now), opponents, checks: track.motionChecks, requireMotion: REQUIRE_MOTION });
}
