// Who a tracked person is, from body appearance alone - the identity provider the game runs with
// by default.
//
// identify.js matches a track against the scanned galleries and leaves its verdict on the track
// (playerId, score, the colour-part scores). This file turns that verdict into the two things the
// rest of the app needs: whether the classifier is confident enough to shoot on (isStableTarget)
// and the identity shape every provider answers in (resolve). Nothing here knows about any
// confirming signal; motion-identity.js wraps the same classifier opinion with phone-motion
// confirmation, and identity.js installs exactly one of the two.

import { reidTargetMinScore } from './identify.js';
import { localSelfId } from './roster.js';

const TARGET_LOCK_MS = 350;
// Re-identification names already need two agreeing checks on a 3 s median score (identify.js),
// so the extra hold before a shot can be short: 350 ms here was a third of the time to shootable.
const TARGET_LOCK_REID_MS = 150;
const TARGET_MIN_SCORE = 0.48;
const TARGET_MIN_PART = 0.22;
// Re-identification identities can also come from accumulated evidence just under the accept
// threshold (0.72, identify.js); a shot needs at least this.


export function isStableTarget(track, now = performance.now()) {
  // A re-identification match has already cleared its own threshold; the colour-part minimums
  // below are for the colour signature, and lighting can push them down for the right person.
  if (track.hasReid) {
    return Boolean(
      track.playerId &&
        Number.isFinite(track.identifiedAt) &&
        now - track.identifiedAt >= TARGET_LOCK_REID_MS &&
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

// What the appearance classifier thinks of this track, in the shape a confirming signal consumes.
export function classifierOpinion(track, now) {
  if (track.selfRejected || track.playerId === localSelfId()) return { self: true };
  return {
    playerId: track.playerId,
    name: track.name,
    confident: isStableTarget(track, now),
    candidates: (track.rankings ?? []).map((r) => r.id),
  };
}

// The identity provider with nothing to confirm with: appearance decides on its own. Nothing to
// permit, nothing to record per frame, nothing arriving from the server and nothing to add to the
// debug overlay - see identity.js for what each of those means.
//
// resolve() is the identification the game used before motion matching existed, in the same shape
// fuseMotion returns so nothing downstream can tell the difference. The old code gated a shot on
// `isStableTarget(track, now) && isAlivePlayer(track.playerId)` with the round playing, and
// targetUnderCrosshair still applies the aliveness and status halves itself, so naming the track
// whenever the classifier is stable reproduces that gate exactly.
export const appearanceIdentity = {
  start() {},
  stop() {}, // nothing to tear down: appearance alone holds no sensor and no per-room state
  observe() {},
  onServerMessage() {},
  debugLine() {
    return '';
  },
  resolve(track, now = performance.now()) {
    if (track.selfRejected || track.playerId === localSelfId()) return { playerId: null, reason: 'self' };
    return isStableTarget(track, now)
      ? { playerId: track.playerId, name: track.name, verified: false, source: 'classifier', reason: 'appearance-only' }
      : { playerId: null, reason: 'unconfirmed' };
  },
};
