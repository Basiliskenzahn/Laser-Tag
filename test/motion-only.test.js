// Motion-only identification: scoring every player against one tracked person when the
// appearance classifier is switched off (the motion-only branch).
//
// These cover the scoring rules rather than the correlation itself - motion.test.js already
// drives motionCheck() against a simulated accelerometer. What matters here is what happens to
// those verdicts afterwards, and in particular the cases where the answer has to be "nobody":
// a lone bystander must not be assigned to whichever player correlated least badly, which is
// the failure mode the "nobody" share exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionOnlyMatch, motionShares } from '../frontend/public/motion/matching.js';

const ALICE = { id: 'a', name: 'Alice' };
const BOB = { id: 'b', name: 'Bob' };
const PLAYERS = [ALICE, BOB];

// A motionCheck() result, as motionShares/motionOnlyMatch receive it.
function check(status, correlation) {
  return { status, correlation, lagMs: 0, reason: status === 'unknown' ? 'unclear' : '' };
}

const share = (rows, id) => rows.find((row) => row.id === id).share;

test('a clear single match beats "nobody" and names that player', () => {
  const checks = { a: check('consistent', 0.92), b: check('unknown', 0.05) };
  const { rows, none } = motionShares(PLAYERS, checks);
  assert.equal(rows[0].id, 'a');
  assert.ok(share(rows, 'a') > none, 'the match should outrank being a stranger');
  assert.equal(share(rows, 'b'), 0, 'an uncorrelated player earns nothing');

  const result = motionOnlyMatch(PLAYERS, checks);
  assert.equal(result.playerId, 'a');
  assert.equal(result.reason, 'motion-only');
  assert.equal(result.source, 'motion');
});

test('a bystander is assigned to nobody, not to the least bad player', () => {
  const checks = { a: check('unknown', 0.12), b: check('unknown', -0.04) };
  const { rows, none } = motionShares(PLAYERS, checks);
  assert.equal(none, 1, 'all of the share should sit on "nobody"');
  assert.equal(share(rows, 'a'), 0);
  assert.equal(share(rows, 'b'), 0);
  assert.equal(motionOnlyMatch(PLAYERS, checks).playerId, null);
});

test('a contradicted player earns nothing however their correlation landed', () => {
  // `inconsistent` is a verdict, not a score: it must not be re-derived from the correlation.
  const checks = { a: check('inconsistent', 0.8), b: check('unknown', 0.1) };
  const { rows } = motionShares(PLAYERS, checks);
  assert.equal(share(rows, 'a'), 0);
  const result = motionOnlyMatch(PLAYERS, checks);
  assert.equal(result.playerId, null);
  assert.equal(result.reason, 'contradicted');
});

test('two players moving alike is a tie, not a guess', () => {
  const checks = { a: check('consistent', 0.81), b: check('consistent', 0.79) };
  const result = motionOnlyMatch(PLAYERS, checks);
  assert.equal(result.playerId, null);
  assert.equal(result.reason, 'ambiguous');
});

test('a player exactly on the confirm threshold ties with being a stranger', () => {
  // consistentAt (0.75) is where the "nobody" weight is pinned, so this is the break-even point
  // by construction - and a tie is not a win.
  const checks = { a: check('consistent', 0.75), b: check('unknown', 0) };
  const { rows, none } = motionShares(PLAYERS, checks);
  assert.ok(Math.abs(share(rows, 'a') - none) < 1e-9, 'threshold should be break-even');
  assert.equal(motionOnlyMatch(PLAYERS, checks).playerId, null, 'break-even is not good enough');

  // ...and a hair above it is.
  assert.equal(motionOnlyMatch(PLAYERS, { a: check('consistent', 0.8), b: check('unknown', 0) }).playerId, 'a');
});

test('missing motion data reads as nobody rather than throwing', () => {
  const { rows, none } = motionShares(PLAYERS, {});
  assert.equal(none, 1);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.share === 0 && row.status === 'unknown'));
  assert.equal(motionOnlyMatch(PLAYERS, {}).playerId, null);
});

test('shares are monotonic in the correlation and never exceed the stranger ceiling', () => {
  const ladder = [0.4, 0.6, 0.8, 0.95, 1].map(
    (r) => motionShares([ALICE], { a: check('consistent', r) }).rows[0].share,
  );
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i] > ladder[i - 1], `share should rise with r (${ladder[i - 1]} -> ${ladder[i]})`);
  }
  // A perfect correlation still leaves room for "a stranger moved the same way", by design.
  assert.ok(ladder.at(-1) < 1);
});

test('a dead player cannot be named, but still appears in the readout', () => {
  const players = [{ ...ALICE, alive: false }, BOB];
  const checks = { a: check('consistent', 0.95), b: check('unknown', 0) };
  const { rows } = motionShares(players, checks);
  assert.equal(rows[0].id, 'a', 'the readout should still show the strongest correlation');
  assert.equal(rows[0].alive, false);
  // ...but naming skips them, and Bob is not consistent, so nobody is named.
  assert.equal(motionOnlyMatch(players, checks).playerId, null);
});

test('overriding the thresholds moves the "nobody" bar, not the consistent/inconsistent verdict', () => {
  // Worth being precise about, because the two halves read the same option names from different
  // places: `status` is decided upstream by motionCheck(), while the share and the "nobody" bar
  // are computed here. Overriding only one of them is how they could disagree - nothing in the
  // app does, since both are called with the defaults.
  const checks = { a: check('consistent', 0.5), b: check('unknown', 0) };
  assert.equal(motionOnlyMatch(PLAYERS, checks).playerId, null, 'r=0.5 does not clear the default bar');
  assert.equal(
    motionOnlyMatch(PLAYERS, checks, { consistentAt: 0.4, inconsistentAt: 0.1 }).playerId,
    'a',
    'lowering the bar lets the same correlation through',
  );
  // The verdict itself is untouched: a check that arrived `inconsistent` stays rejected however
  // the share thresholds are moved.
  assert.equal(
    motionOnlyMatch(PLAYERS, { a: check('inconsistent', 0.9) }, { consistentAt: 0.1 }).playerId,
    null,
  );
});
