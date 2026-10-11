// When an identified person may be shot: the appearance targeting gate.
//
// identify.js matches a track against the scanned galleries and leaves its verdict on the track
// (playerId, score, the colour-part scores). This file turns that verdict into the one question
// the game loop asks of it - "who, if anyone, is this track, confidently enough to shoot?" -
// which is both the crosshair's gate and the label drawGame() writes over a box.
//
// This used to be one of two interchangeable "identity providers" behind identity.js: an object
// with six methods (start/stop/observe/resolve/onServerMessage/debugLine), chosen at load between
// appearance alone and appearance plus a phone-motion cross-check. Phone motion is back (motion/)
// and the seam is still gone, deliberately - see WHY THERE IS NO SEAM below.

import { MOTION_ENABLED } from './env.js';
import { reidTargetMinScore } from './identify.js';
import { motionConfirmation, noteTrackBox } from './motion/index.js';
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
//
// ---- WHY THERE IS NO SEAM ----
//
// Phone-motion confirmation (motion/) consults in here, as four lines, rather than behind the
// two-provider indirection it used to live behind. That is not laziness about restoring the
// original shape; it is what making motion additive-only costs the seam.
//
// The provider seam existed so the game loop could not tell which signals had answered, which
// mattered precisely because motion could answer *differently*: it could veto a correct
// appearance match or silently retarget the shot to another candidate. Both are gone (see
// below), and once motion may only agree with appearance, every motion mode returns exactly what
// appearance returned. There is no second answer for a second provider to give, no identity
// shape for two providers to agree on, and nothing for the indirection to hide. A seam between
// one implementation and the same implementation is not abstraction.
//
// ---- WHAT MOTION MAY AND MAY NOT DO ----
//
// Motion is ADDITIVE ONLY, in every mode. It may confirm (targetConfirmedBy, for the overlay's
// label and the debug line) and it may not do anything else: the id returned below is identical
// to the id returned with motion off, for every possible correlation. The project's own audit
// recorded that the old subsystem "can veto or silently retarget a correct identification", and
// that is the worst thing a confirming signal can do, because it is invisible - a correct,
// confident appearance match simply stopped registering shots.
//
// Retargeting is gone outright. It took a shot that appearance had aimed at one player and
// pointed it at a different one on correlation alone, which is the only failure here that can
// hurt a third party who did nothing. Nothing in motion/ can name a player: motionConfirmation()
// answers only about the id it is handed.
//
// The veto is gone too, and that is the newer half. `?motion=strict` used to withhold a target
// motion had not confirmed, bounded to that one safe direction, and the argument for keeping it
// was that withholding is the entire content of the flag. The rule it broke is simpler than the
// argument: motion contributes to the decision, it does not replace it, and withholding an
// identity appearance has accepted *is* replacing it. It was also unplayable - correlation needs
// variance, so two people standing still reads `unknown` (motion/matching.js's own comment calls
// that by far the most common answer), and strict then made everybody in a stand-off unshootable.
// `?motion=strict` is now an alias for `?motion=on` (env.js).
//
// What motion does contribute to is *detection*: see motion/index.js and screens/game.js, where
// an enrolled player whose phone is moving with no track named as them is a reason to look
// harder. That path produces no box, reaches no threshold and names nobody.
export function targetPlayerId(track, now = performance.now()) {
  if (track.selfRejected || track.playerId === localSelfId()) return null;
  const named = isStableTarget(track, now) ? track.playerId : null;
  if (!MOTION_ENABLED) return named;
  // Record the box for every non-self track, named or not: a track that gets named thirty frames
  // from now needs the history its first check will look back over to already exist. This is the
  // only thing motion does on this path, and `named` is returned untouched.
  noteTrackBox(track);
  return named;
}

// Which signal confirmed this target, for the overlay's label ("Name (moves)") - null when
// nothing did, which includes motion being off. Separate from targetPlayerId() because
// confirmation must not be able to change the answer, and a caller that cannot see it is a
// caller that cannot act on it.
export function targetConfirmedBy(track, now = performance.now()) {
  if (!MOTION_ENABLED) return null;
  const playerId = targetPlayerId(track, now);
  return playerId && motionConfirmation(track, playerId, now).confirmed ? 'moves' : null;
}
