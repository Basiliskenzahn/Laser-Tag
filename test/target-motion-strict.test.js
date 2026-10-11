// `?motion=strict` must not be able to change who may be shot.
//
// Strict used to be the one mode in which motion was allowed to change the outcome: it WITHHELD a
// target whose phone had not confirmed them. The argument for keeping it was that withholding is
// the entire content of the flag and is bounded to the safe direction. The rule it broke is
// simpler: motion contributes to the decision, it does not replace it, and withholding an
// identity that appearance has already accepted is replacing it. It was also unplayable -
// correlation needs variance, so two people standing still reads `unknown` (motion/matching.js's
// own comment calls that by far the most common answer), and strict made everybody in a stand-off
// unshootable.
//
// So `?motion=strict` is now an alias for `?motion=on` (env.js), and the property asserted here is
// the one that regresses if anybody puts the veto back: **for every correlation status the real
// maths can produce - consistent, inconsistent, unknown, and nothing shared at all - the id is the
// id appearance gave.** The spelling is still accepted rather than rejected so a typed-out URL
// degrades to the working mode instead of silently turning motion off; that is asserted too,
// because an alias that quietly disabled motion would also pass every "cannot change the id" test
// in this file.
//
// The companion file target-motion.test.js drives the same property under `?motion=on`, with the
// additional cases (no retargeting, no naming, no threshold relaxation). Two files because env.js
// reads the query string once per process at import.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs } from './helpers/dom.js';
import { OPPONENT, alternating, makeDriver, namedTrack, still } from './helpers/motion-drive.js';

installBrowserStubs({ search: '?motion=strict' }); // before any import that reaches env.js

const { MOTION_ENABLED } = await import('../frontend/public/env.js');
const { targetConfirmedBy, targetPlayerId } = await import('../frontend/public/target.js');
const { motionConfirmation, onMotionMessage, stopMotion } = await import('../frontend/public/motion/index.js');
const { state } = await import('../frontend/public/state.js');

const drive = makeDriver({ targetPlayerId, targetConfirmedBy, motionConfirmation, onMotionMessage });

beforeEach(() => {
  stopMotion(); // clears every relayed player id, so cases cannot leak into each other
  state.myId = 'me';
  state.game = { players: [{ id: OPPONENT, name: 'Rex', alive: true }] };
});

test('`strict` still turns motion ON rather than off', () => {
  // Without this, "strict cannot change the id" would be satisfied by strict disabling motion
  // altogether - true, and not the behaviour anybody typing the flag is asking for.
  assert.equal(MOTION_ENABLED, true);
  const { confirmedBy, probe } = drive({ personMoving: alternating, phoneMoving: alternating });
  assert.equal(probe.status, 'consistent', `the correlation must be running, got ${JSON.stringify(probe)}`);
  assert.equal(confirmedBy, 'moves', 'and a confirmed target is still labelled as one');
});

// Every answer the real correlation can give about a target appearance has accepted, with the
// expected status pinned so a case that stopped exercising its branch is a failure rather than a
// silent pass. `null` for `phoneMoving` means the player shares nothing at all.
const CORRELATIONS = [
  { label: 'a phone moving with the person', phoneMoving: alternating, status: 'consistent', confirmed: 'moves' },
  { label: 'a phone contradicting the person', phoneMoving: (s) => !alternating(s), status: 'inconsistent', confirmed: null },
  { label: 'two people standing still', phoneMoving: still, personMoving: still, status: 'unknown', confirmed: null },
];

for (const { label, phoneMoving, personMoving = alternating, status, confirmed } of CORRELATIONS) {
  test(`strict cannot change the id: ${label}`, () => {
    const { id, confirmedBy, probe } = drive({ personMoving, phoneMoving });
    assert.equal(probe.status, status, `precondition: ${JSON.stringify(probe)}`);
    assert.equal(id, OPPONENT, 'the id must be the one appearance named, whatever motion thinks');
    assert.equal(confirmedBy, confirmed, 'and confirmation is the only thing motion may vary');
  });
}

test('a player who shares nothing at all is still shootable', () => {
  // Permission refused, an older build, a phone with no accelerometer: no samples ever arrive for
  // this player. This is the case strict hurt most - declining one iOS prompt used to make you
  // unshootable for the whole round - and it is the one most likely to happen in a real game.
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
    assert.equal(motionConfirmation(track, OPPONENT, perfNow).status, 'unknown', 'precondition: nothing was shared');
    assert.equal(id, OPPONENT, 'a player whose phone says nothing must still be a target');
  } finally {
    Date.now = realNow;
  }
});

test('strict still cannot redirect a shot to the player whose phone matched', () => {
  // The half of the old behaviour that was already gone, and the worse half: it could hurt a third
  // party who did nothing. The only phone sharing activity here belongs to somebody else and
  // matches the person on screen perfectly.
  const { id } = drive({ personMoving: alternating, phoneMoving: alternating, from: 'kai-uuid' });
  assert.equal(id, OPPONENT, 'the id stays the one appearance named');
  assert.notEqual(id, 'kai-uuid', 'a matching phone must never capture a shot aimed elsewhere');
});

test('strict still cannot name a player appearance did not name', () => {
  const unnamed = { ...namedTrack(), playerId: null, name: null };
  const { id, confirmedBy } = drive({ personMoving: alternating, phoneMoving: alternating, track: unnamed });
  assert.equal(id, null, 'an unidentified person stays unidentified however well their motion matches');
  assert.equal(confirmedBy, null);
});
