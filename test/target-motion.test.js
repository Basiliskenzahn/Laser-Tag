// ?motion=on must be ADDITIVE ONLY: it may confirm who a track is, and it may not change it.
//
// This is the defect that got the whole subsystem deleted. The project's audit recorded that it
// "can veto or silently retarget a correct identification": a correct, confident appearance match
// either stopped registering shots or was redirected to a different player, on a correlation that
// has never been validated against a real accelerometer. Both are invisible to the player holding
// the phone - the shot simply does nothing, or hits somebody else.
//
// So the assertion here is not "motion behaves well". It is the stronger property that under
// ?motion=on the id targetPlayerId() returns is IDENTICAL to the id it returns with motion off,
// whatever the correlation says - driven through the real target.js, the real motion/index.js and
// the real correlation maths, with real consistent, inconsistent and unknown correlations built up
// a sample at a time. ?motion=strict is the one mode allowed to withhold, and it gets its own file
// (the query string is read once per process at import, so it cannot share this one).
//
// What this does NOT establish: that the correlations are correct about anything. The series here
// are generated, exactly as in motion.test.js. See the header of motion/matching.js.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs } from './helpers/dom.js';
import { OPPONENT, alternating, makeDriver, namedTrack, still } from './helpers/motion-drive.js';

installBrowserStubs({ search: '?motion=on' }); // before any import that reaches env.js

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

test('precondition: this file really is running with motion on and not strict', () => {
  assert.equal(MOTION_ENABLED, true);
  assert.equal(REQUIRE_MOTION, false);
});

test('a phone moving with the person on screen confirms the identity it already had', () => {
  const { id, confirmedBy } = drive({ personMoving: alternating, phoneMoving: alternating });
  assert.equal(id, OPPONENT, 'still shootable');
  assert.equal(confirmedBy, 'moves', 'and the overlay can now say so');
});

test('a phone that clearly contradicts the person on screen CANNOT take the identity away', () => {
  // The person stands while the phone moves and moves while the phone stands: the correlation is
  // strongly negative, which is exactly the case the old code turned into a veto. The shot has to
  // survive it. This is the test that fails if anyone re-adds one.
  const { id, confirmedBy, probe } = drive({ personMoving: alternating, phoneMoving: (s) => !alternating(s) });
  assert.equal(id, OPPONENT, 'a contradicting correlation must not veto a confident appearance match');
  assert.equal(confirmedBy, null, 'it just does not confirm');
  // ...and the contradiction really was measured, or the assertion above proves nothing.
  assert.equal(probe.status, 'inconsistent', `got ${JSON.stringify(probe)}`);
  assert.ok(probe.correlation < 0, `correlation ${probe.correlation}`);
});

test('two people standing still is "unknown", and unknown changes nothing either', () => {
  const { id, confirmedBy, probe } = drive({ personMoving: still, phoneMoving: still });
  assert.equal(id, OPPONENT);
  assert.equal(confirmedBy, null);
  assert.equal(probe.status, 'unknown');
});

test('motion cannot name a player appearance did not name', () => {
  // The old fusion had a "classifier names nobody, exactly one phone matches -> that player" rule,
  // so a shot could land on an identity that came from accelerometer correlation alone. Nothing in
  // motion/ can name anybody now: it only answers about the id it is handed.
  const unnamed = { ...namedTrack(), playerId: null, name: null };
  const { id, confirmedBy } = drive({ personMoving: alternating, phoneMoving: alternating, track: unnamed });
  assert.equal(id, null, 'an unidentified person stays unidentified however well their motion matches');
  assert.equal(confirmedBy, null);
});

test('motion cannot redirect a shot to a different player', () => {
  // The other half of the audit's finding, and the worse half: it could hurt a third party who did
  // nothing. Here the only phone sharing activity is a DIFFERENT player from the one appearance
  // named, and it matches the person on screen perfectly.
  const { id } = drive({ personMoving: alternating, phoneMoving: alternating, from: 'kai-uuid' });
  assert.equal(id, OPPONENT, 'the id stays the one appearance named');
  assert.notEqual(id, 'kai-uuid', 'and is never the one whose phone happened to match');
});

test('an appearance match that is not yet stable is not made stable by motion', () => {
  // The other direction of "additive": motion must not lower an appearance threshold either. A
  // perfectly matching phone cannot shorten the lock or excuse a low score, because that would let
  // an unvalidated correlation create a shot appearance alone refused.
  for (const weak of [
    { label: 'score under TARGET_MIN_SCORE', patch: { score: 0.2 } },
    { label: 'a colour part under TARGET_MIN_PART', patch: { grid: 0.01 } },
    // The clock advances through drive(), so holding a track inside the lock means re-stamping
    // identifiedAt every step rather than setting it once.
    { label: 'still inside the lock time', beforeStep: (t, perfNow) => (t.identifiedAt = perfNow - 100) },
  ]) {
    const { id, probe } = drive({
      personMoving: alternating,
      phoneMoving: alternating,
      track: { ...namedTrack(), ...(weak.patch ?? {}) },
      beforeStep: weak.beforeStep,
    });
    assert.equal(id, null, `${weak.label}: motion must not promote this to a target`);
    // And motion really was confirming, so each case is a refused promotion rather than a
    // correlation that happened to have no opinion.
    assert.equal(probe.status, 'consistent', `${weak.label}: precondition, motion confirms`);
  }
});
