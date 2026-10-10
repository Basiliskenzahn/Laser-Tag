// Who is that person? - the one seam between the game and whatever signals answer the question.
//
// The game loop holds a single identity provider. It hands each frame's tracks over and asks who
// a track is, and it cannot tell which signals produced the answer. Exactly one provider is
// installed here, once, at load: appearance only by default, or appearance plus phone-motion
// confirmation when the page is opened with ?motion=on or ?motion=strict (env.js). Deleting
// motion identification, or swapping it for a different confirming signal, is a change to the
// last line of this file and nothing else.
//
// A provider answers five things:
//
//   start()                   ask for whatever permission it needs; must be called from a user
//                             gesture, because that is the only place iOS shows the prompt
//   observe(tracks, seenAt)   keep whatever this frame offers about the tracks just detected
//   resolve(track, now)       who that person is: { playerId, name, verified, source, reason },
//                             playerId null when nobody can be named. Called several times per
//                             frame per track, so it must be cheap and cache its own work.
//                             `confirmedBy`/`vetoedBy`, when present, name the signal that
//                             confirmed or rejected the identity, for the overlay's label.
//   onServerMessage(msg)      take identification signals off the wire (net.js hands over every
//                             message no screen claims)
//   debugLine(now, liveTracks)  one line for the debug overlay; '' for nothing to say
//
// motion/matching.js documents what a confirming signal is allowed to do to a shot, and
// identify.js has the priority order of the appearance signals behind `track.playerId`.

import { MOTION_ENABLED } from './env.js';
import { appearanceIdentity } from './appearance-identity.js';
import { motionIdentity } from './motion-identity.js';

export const identity = MOTION_ENABLED ? motionIdentity : appearanceIdentity;
