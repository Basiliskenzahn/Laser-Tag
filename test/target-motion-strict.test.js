// ?motion=strict - the one mode in which motion is allowed to change the outcome, and the bound
// on how far.
//
// Strict exists to WITHHOLD: a shot counts only when the target's own phone confirms who they are.
// That is a veto, and it is kept deliberately rather than by oversight, for two reasons. It is the
// entire content of the flag - without it `strict` and `on` are the same thing - and it is the only
// way anybody can find out in the field whether the correlation deserves to be trusted, which is
// the question the whole subsystem is blocked on (see the header of frontend/public/motion/
// matching.js). It is off unless typed into the URL.
//
// What is bounded is the direction. Strict may refuse a target; it may never move one. The
// redirect test below is the half of the old behaviour that is gone in both modes, because it is
// the half that could hurt a third party who did nothing.
//
// The companion file target-motion.test.js holds the default mode, where motion cannot change the
// outcome at all. Two files because env.js reads the query string once per process.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs } from './helpers/dom.js';
import { OPPONENT, alternating, makeDriver, namedTrack, still } from './helpers/motion-drive.js';

installBrowserStubs({ search: '?motion=strict' }); // before any import that reaches env.js

const { MOTION_ENABLED, REQUIRE_MOTION } = await import('../frontend/public/env.js');
const { targetConfirmedBy, targetPlayerId } = await import('../frontend/public/target.js');
const { motionConfirmation, onMotionMessage, stopMotion } = await import('../frontend/public/motion/index.js');
const { state } = await import('../frontend/public/state.js');

const drive = makeDriver({ targetPlayerId, targetConfirmedBy, motionConfirmation, onMotionMessage });

beforeEach(() => {
  stopMotion(); // clears every relayed player id, so cases cannot leak into each other
  state.myId = 'me';
  state.game = { players: [{ id: OPPONENT, name: 'Rex', alive: true }] };
});

test('precondition: this file really is running in strict mode', () => {
  assert.equal(MOTION_ENABLED, true);
  assert.equal(REQUIRE_MOTION, true);
});

test('a confirmed target is shootable', () => {
  const { id, confirmedBy } = drive({ personMoving: alternating, phoneMoving: alternating });
  assert.equal(id, OPPONENT);
  assert.equal(confirmedBy, 'moves');
});

test('a contradicted target is withheld', () => {
  const { id, probe } = drive({ personMoving: alternating, phoneMoving: (s) => !alternating(s) });
  assert.equal(probe.status, 'inconsistent', `precondition: ${JSON.stringify(probe)}`);
  assert.equal(id, null, 'strict is the mode where this is allowed to happen');
});

test('a target nobody could measure is withheld too, which is strict mode being expensive', () => {
  // Two people standing still produce no usable correlation, so in strict mode an ordinary
  // stand-off makes everyone unshootable. This is the cost of the flag, asserted so that nobody
  // mistakes it for a bug and nobody promotes this mode to the default without meeting it.
  const { id, probe } = drive({ personMoving: still, phoneMoving: still });
  assert.equal(probe.status, 'unknown', `precondition: ${JSON.stringify(probe)}`);
  assert.equal(id, null);
});

test('a player who shares nothing at all is withheld, not guessed at', () => {
  // Permission refused, an older build, a phone with no accelerometer: no samples ever arrive for
  // this player. Strict has to withhold rather than fall through to appearance, or the flag means
  // nothing the moment somebody declines the prompt.
  const track = namedTrack();
  const realNow = Date.now;
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  try {
    let perfNow = 1000;
    let id = null;
    for (let step = 0; step < 120; step++) {
      if (alternating(step)) track.box = { ...track.box, x: track.box.x + 18 };
      track.lastSeen = perfNow;
      id = targetPlayerId(track, perfNow);
      clock += 100;
      perfNow += 100;
    }
    assert.equal(id, null);
  } finally {
    Date.now = realNow;
  }
});

test('strict still cannot redirect a shot to the player whose phone matched', () => {
  // The bound on the veto: refusing a target is allowed, moving one is not, in this mode as much
  // as the other. The only phone sharing activity here belongs to somebody else and matches the
  // person on screen perfectly.
  const { id } = drive({ personMoving: alternating, phoneMoving: alternating, from: 'kai-uuid' });
  assert.notEqual(id, 'kai-uuid', 'a matching phone must never capture a shot aimed elsewhere');
  assert.equal(id, null, 'the target appearance named is withheld, because ITS phone said nothing');
});

test('strict still cannot name a player appearance did not name', () => {
  const unnamed = { ...namedTrack(), playerId: null, name: null };
  const { id } = drive({ personMoving: alternating, phoneMoving: alternating, track: unnamed });
  assert.equal(id, null);
});
