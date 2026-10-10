// Deciding who a tracked person actually is, from two independent sources.
//
// identify.js matches body appearance and proposes a name. Separately, every phone shares how
// much it is being moved (motion/sensor.js) and motion/matching.js checks whose phone rises and
// falls with the person the camera is watching. resolveIdentity() fuses the two and is the only
// way the rest of the app asks "who is that?" - all of the motion plumbing is deliberately
// sealed in this one file, so the game loop never has to know motion exists. Motion is on by
// default; ?motion=off disables it, and ?motion=strict demands the motion confirmation.

import { fuseMotion, motionCheck, visualActivity } from './motion/matching.js';
import { MotionSensor } from './motion/sensor.js';
import { MOTION_ENABLED, MOTION_OFF, REQUIRE_MOTION } from './env.js';
import { reidTargetMinScore } from './identify.js';
import { send } from './net.js';
import { gamePlayer, localSelfId } from './roster.js';
import { state } from './state.js';

const MOTION_SEND_INTERVAL_MS = 500;
const MOTION_CHECK_MS = 300;
const MOTION_HISTORY_MS = 12_000;
const TARGET_LOCK_MS = 350;
const TARGET_MIN_SCORE = 0.48;
const TARGET_MIN_PART = 0.22;
// How far motion moves a person's re-identification score for one player (motionScoreAdjustment).
const MOTION_SCORE_BONUS = 0.06;
const MOTION_SCORE_PENALTY = 0.08;


export function startMotion() {
  if (!MOTION_ENABLED) return;
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
  if (!MOTION_ENABLED) return;
  const samples = state.motion?.takeOutgoing() ?? [];
  if (samples.length && state.myId) send({ type: 'motion', s: samples });
}

export function onRemoteMotion(playerId, samples) {
  if (!MOTION_ENABLED) return;
  const list = state.remoteMotion.get(playerId) ?? [];
  for (const [t, v] of samples) if (Number.isFinite(t) && Number.isFinite(v)) list.push({ t, v });
  list.sort((a, b) => a.t - b.t);
  const cutoff = Date.now() - MOTION_HISTORY_MS;
  while (list.length && list[0].t < cutoff) list.shift();
  state.remoteMotion.set(playerId, list);
}

export function recordTrackMotion(tracks, seenAt) {
  if (!MOTION_ENABLED) return;
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

function refreshMotionChecks(track, now) {
  if (!track.motionAt || now - track.motionAt >= MOTION_CHECK_MS) {
    track.motionAt = now;
    track.motionChecks = motionChecks(track);
  }
}

// The tracker's `scoreAdjust` (identify.js adds it to a person's typical score for a player): up
// when that player's phone moves the way the person on screen does, down when it clearly doesn't.
// Real games put players at 0.70-0.80+ and non-players at 0.60-0.65, so whenever people move this
// widens the gap: a player scoring 0.66 who walks gets named, a look-alike scoring 0.74 whose
// movement doesn't match the player's phone doesn't. Standing still leaves the score alone.
export function motionScoreAdjustment(track, playerId, now = performance.now()) {
  if (MOTION_OFF) return 0;
  refreshMotionChecks(track, now);
  const status = track.motionChecks?.[playerId]?.status;
  return status === 'consistent' ? MOTION_SCORE_BONUS : status === 'inconsistent' ? -MOTION_SCORE_PENALTY : 0;
}

function isStableTarget(track, now = performance.now()) {
  // A re-identification match has already cleared its own threshold; the colour-part minimums
  // below are for the colour signature, and lighting can push them down for the right person.
  if (track.hasReid) {
    return Boolean(
      track.playerId &&
        Number.isFinite(track.identifiedAt) &&
        now - track.identifiedAt >= TARGET_LOCK_MS &&
        track.score >= reidTargetMinScore(),
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

// Who a tracked person is: the classifier's identification, confirmed or vetoed by motion. This
// is the single seam where motion matching enters the game, and the only thing the game loop and
// the shot calls.
//
// Be aware of what fuseMotion() is allowed to do here, because it decides whether a shot lands:
// when a player's phone motion is judged *inconsistent* with the person under the crosshair it
// either vetoes a correct, classifier-confident identification - the shot then silently does not
// register - or retargets the shot to a different candidate on motion correlation alone. Both
// verdicts rest on correlating accelerometer streams from separate phones, so ordinary field
// conditions that the matching tests do not simulate (clock drift between phones, a phone in a
// pocket rather than held, a backgrounded tab throttling its sensor) can produce them from noise
// alone. ?motion=off takes the whole mechanism out of the loop and skips sensor permission
// prompts, outgoing samples and remote motion history.
export function resolveIdentity(track, now = performance.now()) {
  if (MOTION_OFF) return appearanceOnlyIdentity(track, now);
  refreshMotionChecks(track, now);
  const opponents = (state.game?.players ?? [])
    .filter((p) => p.id !== localSelfId())
    .map((p) => ({ id: p.id, name: p.name, alive: p.alive !== false }));
  return fuseMotion({ classifier: classifierOpinion(track, now), opponents, checks: track.motionChecks, requireMotion: REQUIRE_MOTION });
}

// The identification the game used before motion matching existed, in the same shape
// fuseMotion returns so nothing downstream can tell the difference. The old code gated a shot on
// `isStableTarget(track, now) && isAlivePlayer(track.playerId)` with the round playing, and
// targetUnderCrosshair still applies the aliveness and status halves itself, so naming the track
// whenever the classifier is stable reproduces that gate exactly.
function appearanceOnlyIdentity(track, now) {
  if (track.selfRejected || track.playerId === localSelfId()) return { playerId: null, reason: 'self' };
  return isStableTarget(track, now)
    ? { playerId: track.playerId, name: track.name, verified: false, source: 'classifier', reason: 'motion-off' }
    : { playerId: null, reason: 'unconfirmed' };
}

// The debug overlay's motion line: this phone's sensor, who is sharing, and what the matching
// made of each person on screen. `liveTracks` is the loop's already-filtered list.
export function motionDebugLine(now, liveTracks) {
  if (!MOTION_ENABLED) return 'motion off';
  const sensor = state.motion ? (state.motion.receiving ? 'on' : 'no data') : 'off';
  const players = [...state.remoteMotion.keys()].map((id) => gamePlayer(id)?.name ?? id.slice(0, 4));
  const tracks = liveTracks.map((t) => {
    const id = resolveIdentity(t, now);
    const corr = Object.entries(t.motionChecks ?? {})
      .map(([pid, c]) => `${gamePlayer(pid)?.name ?? '?'}:${c.correlation == null ? c.reason : c.correlation.toFixed(2)}`)
      .join(',');
    return `#${t.id} ${id.name ?? '-'} ${id.reason}${corr ? ` [${corr}]` : ''}`;
  });
  return `motion ${MOTION_OFF ? 'off (bypassed)' : sensor}${REQUIRE_MOTION ? ' strict' : ''} · from ${players.join(',') || 'nobody'}${tracks.length ? `\nMotion ${tracks.join(' | ')}` : ''}`;
}
