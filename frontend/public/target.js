// When an identified person may be shot: the appearance targeting gate.
//
// identify.js matches a track against the scanned galleries and leaves its verdict on the track
// (playerId, score, the colour-part scores). This file turns that verdict into the one question
// the game loop asks of it - "who, if anyone, is this track, confidently enough to shoot?" -
// which is both the crosshair's gate and the label drawGame() writes over a box.
//
// This used to be one of two interchangeable "identity providers" behind identity.js: an object
// with six methods (start/stop/observe/resolve/onServerMessage/debugLine), chosen at load between
// appearance alone and appearance plus a phone-motion cross-check. The motion half is gone, so the
// indirection is gone with it - there is no provider, no seam, and no identity shape to agree on.
// Two functions, called directly.

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

// Who this track is, for the crosshair and for the box label: the player's id once appearance has
// named somebody other than us confidently enough to shoot, and null otherwise.
//
// The self-exclusion is here rather than at the two call sites because it is part of the same
// question - you cannot shoot yourself, so a track the matcher named as us is not a target. It is
// what the old provider's resolve() did before consulting isStableTarget, and both of its callers
// in screens/game.js only ever read the resulting playerId.
//
// Aliveness and round status are deliberately NOT checked here: targetUnderCrosshair() applies
// isAlivePlayer() itself and drawGame() needs to tell a named-but-dead player from an unknown
// person, so folding them in would lose that distinction.
export function targetPlayerId(track, now = performance.now()) {
  if (track.selfRejected || track.playerId === localSelfId()) return null;
  return isStableTarget(track, now) ? track.playerId : null;
}
