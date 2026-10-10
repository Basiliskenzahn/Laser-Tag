// What the closed-set resolver may assign, and what the per-track path keeps when it assigns
// nothing (frontend/public/identify.js resolveClosedSetIdentities).
//
// Every other Tracker test in this repo drives exactly ONE box, and the resolver returns early on
// `visible.length < 2`. That is why the bugs below survived: `matchGallery`'s refusals were
// asserted directly, while production runs every frame through the resolver - screens/game.js
// always passes `closedSet: true` - and the resolver used to ignore `accepted`, `reason`, the
// re-identification threshold, REID_MATCH_MARGIN and every colour floor alike. So the guarantees
// the file documents ("a bystander in frame stays Person", "two players scoring the same is a tie,
// and guessing is worse than waiting") held only while one person was on screen.
//
// These tests therefore drive two or more visible tracks through the real `Tracker.update` with
// `closedSet: true`, with injected timestamps and a fake reid.js. Each one states the premise it
// rests on - what `matchGallery` says about the same signature on its own - so a failure says
// whether matching or resolution changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  Tracker,
  matchGallery,
  roomScoresOnReid,
  reidTargetMinScore,
  getReidThreshold,
} = await import('../frontend/public/identify.js');

// A random unit vector; random high-dimensional vectors are nearly orthogonal to each other.
function unit(n, seed) {
  let state = seed >>> 0 || 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) || 1e-12;
  const v = Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

// Its own seed counter, in its own file. test/reid-matching.test.js consumes a module-level
// counter at import time, so a test inserted into that file re-rolls every later test's vectors.
let nextSeed = 900;

// A unit vector at a chosen cosine similarity to `base`, off in its own random direction (so two
// such vectors are not accidentally similar to each other).
function similarTo(base, cosine) {
  const other = unit(base.length, nextSeed++);
  const dot = other.reduce((s, v, i) => s + v * base[i], 0);
  const orth = other.map((v, i) => v - dot * base[i]);
  const norm = Math.hypot(...orth);
  return base.map((v, i) => cosine * v + Math.sqrt(1 - cosine ** 2) * (orth[i] / norm));
}

// Colour parts that look like a perfect match, so only the re-identification score can say no:
// these tests are about what the resolver does with a verdict, not about the colour features.
const colours = { hist: unit(64, 1), lower: unit(64, 2), grid: unit(192, 3), shape: [2.5, 0.5], embed: unit(256, 4) };
const REX = unit(512, 10);
const KAI = unit(512, 20);

// One gallery sample per player, so bestAngleScore's agreement blend is the sample against itself
// and the reported score is the cosine similarity exactly.
const players = [
  { id: 'rex', name: 'Rex', gallery: [{ ...colours, reid: REX }] },
  { id: 'kai', name: 'Kai', gallery: [{ ...colours, reid: KAI }] },
];
const person = (reid) => ({ ...colours, reid, usable: true });

// A live embedding at chosen cosine similarities to *both* galleries at once, for the cases that
// need a track to have a credible second choice. REX and KAI are near-orthogonal, so the two
// coefficients are the two cosines; they have to satisfy a^2 + b^2 <= 1, which is why a track
// cannot score 0.8 against two different people.
function blend(rexCosine, kaiCosine) {
  const rest = Math.sqrt(Math.max(0, 1 - rexCosine * rexCosine - kaiCosine * kaiCosine));
  const side = unit(512, 31337);
  const v = REX.map((x, i) => rexCosine * x + kaiCosine * KAI[i] + rest * side[i]);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const VIDEO = { videoWidth: 640, videoHeight: 480 };
// Far enough apart that association never confuses them, so two boxes really are two tracks.
const LEFT = { x: 60, y: 60, w: 110, h: 340, score: 0.9 };
const RIGHT = { x: 420, y: 60, w: 110, h: 340, score: 0.9 };

// Drives `checks` frames of the given boxes, 300 ms apart, with a reid.js stand-in that answers
// per track position. Returns the tracks after every check.
function driveTwo(vectorFor, checks, { boxes = [LEFT, RIGHT], closedSet = true } = {}) {
  const tracker = new Tracker();
  const reid = { latest: (track) => vectorFor(track, track.box.x < 300 ? 'left' : 'right'), request() {} };
  let now = 1000;
  const frames = [];
  for (let i = 0; i < checks; i++) {
    now += 300;
    const tracks = tracker.update(boxes.map((b) => ({ ...b })), VIDEO, players, 'self', now, {
      reid,
      closedSet,
      includeRejected: true,
    });
    frames.push({ now, tracks, left: tracks.find((t) => t.box.x < 300), right: tracks.find((t) => t.box.x >= 300) });
  }
  return frames;
}

// ---- The three reproduced scenarios ----

test('a bystander refused on score is not named just because a player is on screen too', () => {
  // Someone who is not enrolled, standing next to someone who is. The resolver used to hand this
  // track a name regardless of the score matching had refused it at.
  //
  // The two candidate scores are deliberately well apart (0.40 against Kai, 0.10 against Rex): a
  // bystander who happened to score about the same against both would be refused by the tie rule,
  // which would make this test pass for the wrong reason and leave the accept floor untested.
  const bystander = blend(0.1, 0.4);
  const realRex = similarTo(REX, 0.85);

  const premise = matchGallery(person(bystander), players, 'self', { includeRejected: true, closedSet: true });
  assert.equal(premise.accepted, false, 'premise: matching refuses this signature');
  assert.equal(premise.reason, 'score', 'premise: on score, not on the margin');
  assert.ok(premise.score < getReidThreshold(), `premise: under the accept threshold, got ${premise.score}`);
  const gap = premise.score - premise.rankings[1].score;
  assert.ok(gap > 0.03, `premise: and no tie either, the two candidates are ${gap} apart`);

  const frames = driveTwo((_track, side) => (side === 'left' ? realRex : bystander), 4);
  for (const [i, frame] of frames.entries()) {
    assert.equal(frame.left.playerId, 'rex', `check ${i}: the real player is still named`);
    assert.equal(frame.right.playerId, null, `check ${i}: the bystander must stay an unnamed person`);
    assert.equal(frame.right.name, null, `check ${i}: and carry no name to draw`);
  }
});

test('two people equidistant from two galleries stay unresolved, and so unshootable', () => {
  // Exactly between Rex and Kai, so each scores the same against both. decideRankings calls that
  // a tie and refuses it; the resolver used to name both on check 0 - arbitrarily, since it is
  // greedy over equal scores - and both were shootable 150 ms later.
  const between = (() => {
    const v = REX.map((x, i) => x + KAI[i]);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  })();

  const premise = matchGallery(person(between), players, 'self', { includeRejected: true, closedSet: true });
  assert.equal(premise.accepted, false, 'premise: matching refuses a tie');
  assert.equal(premise.reason, 'margin', 'premise: with reason margin');
  assert.ok(premise.score > getReidThreshold(), `premise: and it is the margin that refuses it, not the score (${premise.score})`);

  const frames = driveTwo(() => between, 3);
  for (const [i, frame] of frames.entries()) {
    for (const side of ['left', 'right']) {
      // playerId is what every shot gate starts from (appearance-identity.js isStableTarget and
      // everything built on it), so an unresolved track is unshootable by construction - asserted
      // without importing across that seam, which would drag in the DOM.
      assert.equal(frame[side].playerId, null, `check ${i}, ${side}: a tie must stay unresolved`);
      assert.equal(frame[side].identifiedAt, null, `check ${i}, ${side}: and never start a shot lock`);
    }
  }
});

test('a dipping player keeps their name and their shot lock against a look-alike', () => {
  // The real Rex drops to 0.58 for three checks - a side view - while a look-alike standing beside
  // him scores 0.72 against Rex's gallery. The names used to swap: the raw-score revocation wiped
  // the median that was protecting the real player, and the resolver then handed his name to the
  // look-alike and actively mislabelled him as Kai, resetting identifiedAt and so the shot lock on
  // both tracks.
  const lookAlike = similarTo(REX, 0.72);
  let realRex = similarTo(REX, 0.86);
  const frames = [];
  const tracker = new Tracker();
  const reid = { latest: (track) => (track.box.x < 300 ? realRex : lookAlike), request() {} };
  let now = 1000;
  const step = () => {
    now += 300;
    const tracks = tracker.update([{ ...LEFT }, { ...RIGHT }], VIDEO, players, 'self', now, {
      reid,
      closedSet: true,
      includeRejected: true,
    });
    frames.push({ left: tracks.find((t) => t.box.x < 300), right: tracks.find((t) => t.box.x >= 300) });
  };

  for (let i = 0; i < 4; i++) step();
  const named = frames.at(-1);
  assert.equal(named.left.playerId, 'rex', 'the real player is named before the dip');
  const lockedAt = named.left.identifiedAt;
  assert.ok(Number.isFinite(lockedAt), 'and has a shot lock');

  realRex = similarTo(REX, 0.58);
  for (let i = 0; i < 3; i++) step();
  realRex = similarTo(REX, 0.86);
  for (let i = 0; i < 2; i++) step();

  for (const [i, frame] of frames.slice(4).entries()) {
    assert.equal(frame.left.playerId, 'rex', `dip check ${i}: the real player keeps their name`);
    assert.equal(frame.left.identifiedAt, lockedAt, `dip check ${i}: and keeps the same shot lock`);
    assert.ok(frame.left.score >= reidTargetMinScore(), `dip check ${i}: and stays shootable (${frame.left.score})`);
    assert.notEqual(frame.right.playerId, 'rex', `dip check ${i}: the look-alike never takes the name`);
  }
});

// ---- What the resolver may and may not do ----

test('losing a player to a better-supported track does not relabel the loser in the same check', () => {
  // Changing an identity is SWITCH_STREAK's job - four agreeing checks - so a greedy pass must not
  // be able to move a track from one name straight to another, which is the mechanism by which a
  // look-alike takes a name. The loser becomes an unnamed person instead.
  //
  // This track is deliberately a credible Kai as well as a Rex: 0.67 clears the accept threshold,
  // so nothing but the no-switch rule is keeping Kai off it on this check. (On a *later* check,
  // once it holds no name, assigning it Kai is the closed-set answer and does happen - see the
  // note at the end of this test.)
  const dual = blend(0.73, 0.68);
  const premise = matchGallery(person(dual), players, 'self', { includeRejected: true, closedSet: true });
  assert.equal(premise.id, 'rex', 'premise: Rex is the better of the two');
  assert.equal(premise.accepted, true, 'premise: and an outright accept, not a tie');
  const kaiRanking = premise.rankings.find((r) => r.id === 'kai');
  assert.ok(kaiRanking.score > getReidThreshold(), `premise: Kai is credible too, at ${kaiRanking.score}`);

  let left = dual;
  let right = null;
  const tracker = new Tracker();
  const reid = { latest: (track) => (track.box.x < 300 ? left : right), request() {} };
  let now = 1000;
  const step = (boxes) => {
    now += 300;
    const tracks = tracker.update(boxes.map((b) => ({ ...b })), VIDEO, players, 'self', now, {
      reid,
      closedSet: true,
      includeRejected: true,
    });
    return { left: tracks.find((t) => t.box.x < 300), right: tracks.find((t) => t.box.x >= 300) };
  };

  let frame;
  for (let i = 0; i < 4; i++) frame = step([LEFT]);
  assert.equal(frame.left.playerId, 'rex', 'the left track holds Rex');

  // The real Rex walks in: a fresh track, so its median is not held back by any history.
  right = similarTo(REX, 0.97);
  frame = step([LEFT, RIGHT]);
  assert.equal(frame.right.playerId, 'rex', 'the newcomer takes Rex');
  assert.equal(frame.left.playerId, null, 'and the track that lost him is an unnamed person...');
  assert.notEqual(frame.left.playerId, 'kai', '...not quietly relabelled as the player left over');

  // For the record, and so the boundary is not mistaken for a stronger claim than it is: on the
  // next check the loser holds no name, Kai is credible for it and unclaimed, and it is assigned -
  // which is what closed-set assignment is for. The rule bounds *when* a name may change, not
  // whether this track may ever be Kai.
  frame = step([LEFT, RIGHT]);
  assert.equal(frame.left.playerId, 'kai', 'a track with no name may be given its next-best player');
});

test('a track the resolver cannot assign keeps the name the per-track logic latched', () => {
  // The resolver used to clear every visible track it did not assign, which overrode the latch:
  // "a known box should only lose/change its identity when the track disappears, a duplicate
  // conflict is resolved, or another player wins the switch hysteresis" (Tracker.update). Being
  // unassignable for a few checks is none of those three.
  //
  // 0.62 is the interesting band, and the only one that isolates this rule. It is *above*
  // REID_REVOKE_SCORE, so no revocation miss is ever counted and nothing legitimately takes the
  // name away; and once it has filled the median it is *below* the accept floor, so the resolver
  // has no assignable candidate for the track either. A single bad check would not do: the median
  // would absorb it and the resolver would still have a candidate, so the test would pass without
  // the rule being present.
  let left = similarTo(REX, 0.86);
  const right = blend(0.1, 0.4); // a bystander, never assignable
  const tracker = new Tracker();
  const reid = { latest: (track) => (track.box.x < 300 ? left : right), request() {} };
  let now = 1000;
  const step = () => {
    now += 300;
    const tracks = tracker.update([{ ...LEFT }, { ...RIGHT }], VIDEO, players, 'self', now, {
      reid,
      closedSet: true,
      includeRejected: true,
    });
    return { left: tracks.find((t) => t.box.x < 300), right: tracks.find((t) => t.box.x >= 300) };
  };

  let frame;
  for (let i = 0; i < 4; i++) frame = step();
  assert.equal(frame.left.playerId, 'rex');
  const lockedAt = frame.left.identifiedAt;

  left = similarTo(REX, 0.62);
  const seen = [];
  for (let i = 0; i < 7; i++) {
    frame = step();
    seen.push({
      playerId: frame.left.playerId,
      identifiedAt: frame.left.identifiedAt,
      median: frame.left.rankings.find((r) => r.id === 'rex')?.score,
      reidMisses: frame.left.reidMisses ?? 0,
    });
  }

  assert.ok(
    seen.at(-1).median < getReidThreshold(),
    `premise: the median must have fallen under the accept floor, got ${seen.at(-1).median}`,
  );
  assert.equal(seen.at(-1).reidMisses, 0, 'premise: and no revocation miss was ever counted at 0.62');
  for (const [i, s] of seen.entries()) {
    assert.equal(s.playerId, 'rex', `check ${i}: an unassignable check does not unname a latched track`);
    assert.equal(s.identifiedAt, lockedAt, `check ${i}: and does not restart its shot lock`);
  }
  assert.equal(frame.right.playerId, null, 'while the bystander is still nobody');
});

// ---- One scale for the room (bug 2) ----

test('one reid-less gallery puts the whole room on the blended path', () => {
  // A colour/embed cosine and an OSNet cosine are not the same quantity: colour runs 0.95+ for the
  // same person and 0.85-0.96 for a different person in similar clothes, OSNet 0.70-0.85 for the
  // correct person. Scored per pair, the one player whose phone failed OSNet is read on the higher
  // scale and outscores every correct re-identification match in the room.
  const mixed = [
    { id: 'rex', name: 'Rex', gallery: [{ ...colours, reid: REX }] },
    { id: 'kai', name: 'Kai', gallery: [{ ...colours }] }, // OSNet failed at enrolment
  ];
  assert.equal(roomScoresOnReid(players), true, 'every gallery has re-identification');
  assert.equal(roomScoresOnReid(mixed), false, 'one reid-less gallery is enough to drop the room');

  // The live person IS Rex, at a re-identification cosine of 0.80.
  const live = person(similarTo(REX, 0.8));
  const m = matchGallery(live, mixed, 'self', { includeRejected: true, closedSet: true });
  for (const r of m.rankings) {
    assert.equal(r.hasReid, false, `${r.id} must be scored on the blended path like everyone else`);
  }
  // ...and the same signature in an all-re-identification room is scored on re-identification.
  const unmixed = matchGallery(live, players, 'self', { includeRejected: true, closedSet: true });
  assert.equal(unmixed.id, 'rex');
  assert.equal(unmixed.hasReid, true);
  assert.ok(Math.abs(unmixed.score - 0.8) < 0.01, `and at the cosine itself, got ${unmixed.score}`);
});

test('the 3 s median is kept for every re-identification candidate, not just a top-ranked one', () => {
  // smoothed() used to key on the *best* candidate's `hasReid`, so whenever a candidate without a
  // re-identification score happened to top the list, smoothRankings never ran and the median was
  // switched off for the whole track - including its re-identification candidates, which were then
  // judged on a single raw check. REID_DEFAULT_THRESHOLD was lowered to 0.65 on the assumption that
  // the median would absorb spikes, so this is the assumption and not a detail.
  //
  // Reachable because a gallery is only all-or-nothing for `reid` across *angles*: one enrolled
  // angle can lack it while the player still counts as re-identifiable.
  const split = [
    { id: 'rex', name: 'Rex', gallery: [{ ...colours, reid: REX }, { ...colours, reid: [] }] },
    { id: 'kai', name: 'Kai', gallery: [{ ...colours, reid: KAI }] },
  ];
  assert.equal(roomScoresOnReid(split), true, 'premise: the room is still on the re-identification scale');

  // Anti-correlated with every embedding in the room, so both re-identification scores go negative
  // and Rex's reid-less angle - which can only score ~0 - tops his ranking.
  const live = (() => {
    const v = REX.map((x, i) => -(x + KAI[i]));
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  })();

  const tracker = new Tracker();
  const reid = { latest: () => live, request() {} };
  let track;
  let now = 1000;
  for (let i = 0; i < 3; i++) {
    now += 300;
    track = tracker.update([{ ...LEFT }], VIDEO, split, 'self', now, { reid, closedSet: false, includeRejected: true })[0];
  }

  assert.equal(track.rankings[0].hasReid, false, 'premise: the top-ranked candidate carries no re-identification score');
  assert.ok(
    track.rankings.some((r) => r.hasReid),
    'premise: while another candidate does',
  );
  assert.equal(track.reidHistory?.get('kai')?.length, 3, "the reid candidate's median history is still being kept");
});

// ---- Evidence (bug 3) ----

// Drives one box - so the resolver returns early and this is the per-track path alone - against a
// room whose two galleries sit a chosen distance apart.
function driveOne(live, room, checks) {
  const tracker = new Tracker();
  const reid = { latest: () => live, request() {} };
  let now = 1000;
  const out = [];
  for (let i = 0; i < checks; i++) {
    now += 300;
    const track = tracker.update([{ ...LEFT }], VIDEO, room, 'self', now, { reid, closedSet: true, includeRejected: true })[0];
    out.push(track);
  }
  return out;
}

test('a persistent near-tie is never named, however long it persists', () => {
  // The margin guarantee, through the evidence path. `addEvidence` recorded the single best
  // candidate per check, so a stable leader's bucket grew while the runner-up's stayed 0 and
  // EVIDENCE_MARGIN was passed trivially; evidenceWinner then handed back a stored match whose
  // reason was 'margin' - the one thing softLabelMatch refuses to label - and trackerCandidate
  // consults the evidence winner *before* softLabelMatch. A permanent tie was named on check 2.
  //
  // 0.700 against 0.675 is inside REID_MATCH_MARGIN, so it is a tie, but the gap is wide enough
  // that the two buckets would diverge past EVIDENCE_MARGIN within about eleven checks. So this
  // pins the refusal itself, not the arithmetic of the buckets rising together.
  const live = unit(512, 4242);
  const room = [
    { id: 'rex', name: 'Rex', gallery: [{ ...colours, reid: similarTo(live, 0.7) }] },
    { id: 'kai', name: 'Kai', gallery: [{ ...colours, reid: similarTo(live, 0.675) }] },
  ];

  const premise = matchGallery(person(live), room, 'self', { includeRejected: true, closedSet: true });
  assert.equal(premise.reason, 'margin', 'premise: a tie');
  assert.ok(premise.score - premise.rankings[1].score < 0.03, 'premise: inside the accept margin');
  assert.ok(premise.score > 0.65, 'premise: and both are over the threshold, so only the margin refuses it');

  const tracks = driveOne(live, room, 16);
  for (const [i, track] of tracks.entries()) {
    assert.equal(track.playerId, null, `check ${i}: a tie must never be named`);
  }
});

test('evidence is recorded per candidate, so EVIDENCE_MARGIN measures a real margin', () => {
  // Two candidates that both clear the evidence floor, far enough apart to be no tie. The
  // runner-up's bucket has to be written for the margin to mean anything; it used to stay empty
  // whichever way the check went.
  const live = unit(512, 5151);
  const room = [
    { id: 'rex', name: 'Rex', gallery: [{ ...colours, reid: similarTo(live, 0.9) }] },
    { id: 'kai', name: 'Kai', gallery: [{ ...colours, reid: similarTo(live, 0.72) }] },
  ];
  const premise = matchGallery(person(live), room, 'self', { includeRejected: true, closedSet: true });
  assert.equal(premise.accepted, true, 'premise: a clear winner, not a tie');
  assert.ok(premise.rankings[1].score > 0.65, 'premise: and the runner-up is still over the evidence floor');

  const track = driveOne(live, room, 4).at(-1);
  assert.equal(track.playerId, 'rex', 'the winner is named');
  assert.ok(track.evidence.get('rex') > 0, 'the winner accumulates evidence');
  assert.ok(track.evidence.get('kai') > 0, 'and so does the runner-up it had to beat');
  assert.ok(
    track.evidence.get('rex') > track.evidence.get('kai'),
    'with the winner ahead, which is what the margin is then able to compare',
  );
});

test('the local player never banks evidence, even as a credible runner-up', () => {
  // The local player is a candidate in closed-set mode - that is how the self-match guard sees
  // them - and the 'self' rejection only fires when they are the *best* candidate. So recording a
  // bucket per candidate has to skip them explicitly, or the evidence path can name a track as the
  // owner of the camera looking at it once the real leader fades. Nothing may make your own name
  // land on a track: it is what stops you shooting yourself.
  const SELF = unit(512, 55);
  const rest = Math.sqrt(Math.max(0, 1 - 0.73 * 0.73 - 0.68 * 0.68));
  const side = unit(512, 999);
  const live = (() => {
    const v = REX.map((x, i) => 0.73 * x + 0.68 * SELF[i] + rest * side[i]);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  })();
  const room = [
    { id: 'rex', name: 'Rex', gallery: [{ ...colours, reid: REX }] },
    { id: 'self', name: 'Me', gallery: [{ ...colours, reid: SELF }] },
  ];

  const premise = matchGallery(person(live), room, 'self', { includeRejected: true, closedSet: true });
  assert.equal(premise.id, 'rex', 'premise: the local player is the runner-up, not the best match');
  assert.notEqual(premise.reason, 'self', 'premise: so the self rejection does not fire');
  const selfRanking = premise.rankings.find((r) => r.id === 'self');
  assert.ok(selfRanking.score > getReidThreshold(), `premise: and is over the evidence floor at ${selfRanking.score}`);

  const track = driveOne(live, room, 5).at(-1);
  assert.equal(track.playerId, 'rex');
  assert.equal(track.evidence.has('self'), false, 'no evidence may be banked for the local player');
});

// ---- Revocation and the median (bug 4) ----

test('a three-check dip does not revoke a player the median still holds', () => {
  // Revocation counted raw checks while acceptance, shootability and track.score were all the
  // median over REID_HISTORY_MS, so the mechanism that exists to absorb a dip was overridden by
  // the one that reads the dip. Three consecutive checks is 750-900 ms at RECHECK_MS: an ordinary
  // side view or motion-blur burst.
  const tracker = new Tracker();
  let current;
  const reid = { latest: () => current, request() {} };
  let now = 1000;
  const steps = [0.85, 0.87, 0.84, 0.86, 0.55, 0.56, 0.54, 0.85].map((score) => {
    current = similarTo(REX, score);
    now += 300;
    const track = tracker.update([{ ...LEFT }], VIDEO, players, 'self', now, { reid, closedSet: true })[0];
    return { playerId: track.playerId, score: track.score, reidMisses: track.reidMisses ?? 0 };
  });

  assert.equal(steps[3].playerId, 'rex', 'named before the dip');
  assert.equal(steps[6].reidMisses, 3, 'all three low checks were counted as misses');
  for (const [i, s] of steps.entries()) {
    if (i < 3) continue;
    assert.equal(s.playerId, 'rex', `check ${i}: the name survives`);
    assert.ok(s.score >= reidTargetMinScore(), `check ${i}: and so does shootability (${s.score})`);
  }
});

// ---- Clearing an identity clears all of it (bug 5) ----

test('a track the resolver displaces loses its revocation and evidence state too', () => {
  // clearIdentity reset fifteen fields and left reidMisses, misses, evidence, evidenceDetails and
  // reidHistory behind, and the two resolver call sites compensated for none of them. So a track
  // cleared mid-dip was revoked again by the *first* slightly-low check after being re-named, and
  // a track cleared by duplicate resolution kept a full bucket for the player it had just lost -
  // which evidenceWinner then re-proposed, flip-flopping the track every two checks and restarting
  // its shot lock each time.
  let left = similarTo(REX, 0.8);
  let right = null;
  const tracker = new Tracker();
  const reid = { latest: (track) => (track.box.x < 300 ? left : right), request() {} };
  let now = 1000;
  const step = (boxes) => {
    now += 300;
    const tracks = tracker.update(boxes.map((b) => ({ ...b })), VIDEO, players, 'self', now, {
      reid,
      closedSet: true,
      includeRejected: true,
    });
    return { left: tracks.find((t) => t.box.x < 300), right: tracks.find((t) => t.box.x >= 300) };
  };

  let frame;
  for (let i = 0; i < 4; i++) frame = step([LEFT]);
  assert.equal(frame.left.playerId, 'rex');
  assert.ok(frame.left.evidence.get('rex') > 0, 'with evidence banked for Rex');

  // Two low raw checks bank some reidMisses while the median still holds the name...
  left = similarTo(REX, 0.55);
  for (let i = 0; i < 2; i++) frame = step([LEFT]);
  assert.equal(frame.left.playerId, 'rex', 'still named: the median holds');
  assert.equal(frame.left.reidMisses, 2, 'but two misses are on the clock');

  // ...and now the real Rex walks in and takes him.
  right = similarTo(REX, 0.95);
  frame = step([LEFT, RIGHT]);
  assert.equal(frame.right.playerId, 'rex', 'the better-supported track takes Rex');
  assert.equal(frame.left.playerId, null, 'and this one is cleared');
  assert.equal(frame.left.reidMisses, 0, 'its revocation clock is cleared with it');
  assert.equal(frame.left.misses, 0, 'and its miss count');
  assert.equal(frame.left.evidence.size, 0, 'and the evidence for the player it lost');
  assert.equal(frame.left.evidenceDetails.size, 0, 'including the stored match that would re-propose it');
  assert.equal(frame.left.reidHistory?.size ?? 0, 0, "and the median history of somebody else's scores");
});
