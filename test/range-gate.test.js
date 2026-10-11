// The live identification range gate (frontend/public/identify.js).
//
// `MIN_MATCH_HEIGHT_RATIO` / `MIN_BOX_WIDTH_RATIO` are the range limit: below them
// `extractSignature` stamps `usable: false` and `bestAngleScore` returns null, so the box is never
// identified at any score on any path. They were 0.18 / 0.035, which refused a player past roughly
// 10-12 m; they are now 0.065 / 0.018, derived from a ~65 degrees field of view across the long
// side (a 1.75 m person at 20 m is about 7% of frame height).
//
// These drive the real `extractSignature` through the resampling canvas stub, because the gate is
// read off the pixel geometry of a frame. Box geometry is written out as literals rather than
// computed from the constants: a test that derives its expectation from the number it is guarding
// asserts x >= x.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bands, frame, installCanvasStub } from './fixtures/synthetic-frame.mjs';

installCanvasStub();

const { Tracker, averageSignatures, extractSignature, matchGallery, MIN_SHAPE_SCORE, EVIDENCE_MIN_PART, EVIDENCE_MIN_SCORE } =
  await import('../frontend/public/identify.js');

// 720p landscape, the frame the ratios are quoted against.
const VIDEO = { width: 1280, height: 720 };
const PAINT = bands({ head: [196, 158, 130], shirt: [210, 60, 55], accent: [240, 196, 70], trousers: [40, 50, 120] });

// Up close: the enrolment-grade box every control below is taken from.
const NEAR = { x: 100, y: 100, w: 120, h: 300, score: 0.9 }; // 0.417 of frame height

// Past the *old* gate but inside the new one. 0.174 of frame height was refused outright before.
const OLD_GATE_REFUSED = { x: 400, y: 300, w: 50, h: 125, score: 0.9 };

// A standing person at about 20 m: 58 px tall is 0.0806 of the frame, 24 px wide is 0.01875 of it.
// Both clear the new gate, and it is the *width* that is nearly spent - see WIDTH_BINDS.
const FAR_STANDING = { x: 600, y: 300, w: 24, h: 58, score: 0.9 };

// The same person two metres further off: 55 px tall is still 0.0764, over the 0.065 height floor,
// but 22 px wide is 0.0172 and under the 0.018 width floor. This is the pair that shows which axis
// actually ends the range for someone standing up.
const WIDTH_BINDS = { x: 600, y: 300, w: 22, h: 55, score: 0.9 };

// Under both floors: 40 px tall is 0.0556 of the frame.
const BELOW_GATE = { x: 500, y: 300, w: 20, h: 40, score: 0.9 };

const person = (box) => ({ box, paint: PAINT });
const sceneFor = (box) => frame([person(box)], VIDEO);

function unit(n, seed) {
  let state = seed >>> 0 || 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) || 1e-12;
  const v = Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

let nextSeed = 700;

// A unit vector at a chosen cosine similarity to `base`.
function similarTo(base, cosine) {
  const other = unit(base.length, nextSeed++);
  const dot = other.reduce((s, v, i) => s + v * base[i], 0);
  const orth = other.map((v, i) => v - dot * base[i]);
  const norm = Math.hypot(...orth);
  return base.map((v, i) => cosine * v + Math.sqrt(1 - cosine ** 2) * (orth[i] / norm));
}

const REX_REID = unit(512, 10);

// Rex, enrolled up close. Deliberately ONE gallery sample: with a single angle the agreement blend
// in bestAngleScore is the sample against itself, so the reported score is the cosine similarity
// exactly and the thresholds below can be written as literals.
function rexGallery({ reid = REX_REID } = {}) {
  const entry = averageSignatures([extractSignature(sceneFor(NEAR), NEAR)]);
  if (reid) entry.reid = reid;
  return [{ id: 'rex', name: 'Rex', gallery: [entry] }];
}

// A live signature from the real pixel path, optionally carrying the embedding the caller attaches
// (Tracker.update does this for `reid`).
function live(box, { reid = null } = {}) {
  const signature = extractSignature(sceneFor(box), box);
  if (reid) signature.reid = reid;
  return signature;
}

const match = (signature, players = rexGallery()) => matchGallery(signature, players, null, { includeRejected: true });

// ---- What the gate admits ----

test('a player at about 20 m is identified, where the old gate refused them at any score', () => {
  // The whole point of the range change: 58 px of a 720 px frame used to produce no ranking at all.
  const strong = similarTo(REX_REID, 0.8);
  const far = match(live(FAR_STANDING, { reid: strong }));
  assert.ok(far, 'a box at 0.0806 of frame height must produce a ranking');
  assert.equal(far.id, 'rex');
  assert.equal(far.hasReid, true);
  assert.equal(far.accepted, true);
  assert.ok(Math.abs(far.score - 0.8) < 0.001, `the score is the cosine similarity, got ${far.score}`);

  // And the band of ranges between the old gate and the new one, which is where most of the extra
  // reach actually lives.
  const mid = match(live(OLD_GATE_REFUSED, { reid: strong }));
  assert.ok(mid, 'so must 0.174, which the old 0.18 gate refused');
  assert.equal(mid.accepted, true);
});

test('the colour-only and MobileNet paths reach just as far - the gate is one number for all of them', () => {
  // There is no signal-specific relaxation any more: whatever passes the gate is scored by
  // whichever signal the room has. A distant box with no re-identification anywhere is ranked on
  // colours, which is exactly why the closed-set score floor below has to hold.
  const colourOnly = rexGallery({ reid: null });
  const far = match(live(FAR_STANDING), colourOnly);
  assert.ok(far, 'a distant box is ranked on colours alone');
  assert.equal(far.hasReid, false);
});

test('width is what ends the range for someone standing, not height', () => {
  // 0.0764 of frame height clears the 0.065 height floor; 0.0172 of the width does not clear
  // 0.018. Same pixels, two metres further off than FAR_STANDING, and refused - so the usable
  // reach for a standing person is the width floor's 0.080, not the height floor's 0.065.
  const reid = similarTo(REX_REID, 0.95);
  assert.equal(live(WIDTH_BINDS, { reid }).usable, false, 'too narrow is still too far');
  assert.equal(match(live(WIDTH_BINDS, { reid })), null, 'and re-identification does not rescue it at any score');

  // The control: 2 px wider is inside the gate, so what refused it was the width and not the paint.
  assert.equal(live(FAR_STANDING, { reid }).usable, true);
  assert.ok(match(live(FAR_STANDING, { reid })));
});

test('a box under the gate is refused and costs no re-identification inference', () => {
  // An unusable box can never be identified on any path, so an OSNet inference on it would be
  // computed and thrown away at bestAngleScore. It used to be spent on every check of every
  // too-small box in frame.
  const strong = () => similarTo(REX_REID, 0.95);
  const below = driveOnce([BELOW_GATE], strong);
  assert.equal(below.reid.requests.length, 0, 'no inference may be spent under the gate');
  assert.equal(below.tracks[0].playerId, null, 'and it is not identified');

  // Specificity: the skip is "this box can never be identified", not "this box is small". A box
  // just inside the gate, and one that passes comfortably, both still ask for an embedding.
  assert.equal(driveOnce([FAR_STANDING], strong).reid.requests.length, 1, 'a 20 m box still embeds');
  assert.equal(driveOnce([NEAR], strong).reid.requests.length, 1, 'a close box still embeds');
});

// A stand-in for reid.js that records every embedding it is asked to compute.
function fakeReid(vectorFor) {
  const requests = [];
  return {
    requests,
    latest: (track) => vectorFor(track.box),
    request: (track, _source, box) => requests.push(box),
  };
}

function driveOnce(boxes, vectorFor, players = rexGallery()) {
  const tracker = new Tracker();
  const reid = fakeReid(vectorFor);
  const scene = frame(boxes.map(person), VIDEO);
  const tracks = tracker.update(boxes, scene, players, 'self', 1000, { reid, includeRejected: true });
  return { tracks, reid };
}

// ---- The closed-set score floor ----
//
// Closed set assumes everyone in frame is a player, so it drops the colour path's corroborating
// gates. It used to drop the score floor with them (`accepted: best.hasReid ? !reason : true`),
// which named the best of a field of non-matches at *any* score - a track was watched being named
// at 0.0. With a 0.18 gate a distant box never reached a colour ranking, so that was unreachable
// from range; at 0.065 it is directly reachable, and on a phone where OSNet failed to load a tiny
// distant box would be named with no threshold whatsoever. That is a wrong hit, not a cosmetic bug.

// Colour features that are independent of the gallery's. In 64-256 dimensions random vectors are
// near-orthogonal, so every cosine lands at ~0 and the score is whatever the weights give `shape`.
const STRANGER = { hist: unit(64, 41), lower: unit(64, 42), grid: unit(192, 43), shape: [2.5, 0.5], embed: unit(256, 44) };

test('closed set does not name a colour-only match that fails the score floor', () => {
  const colourOnly = rexGallery({ reid: null });
  const m = matchGallery(STRANGER, colourOnly, null, { closedSet: true, includeRejected: true });
  assert.ok(m, 'the stranger is still ranked, so the refusal is the floor and not the gate');
  assert.equal(m.hasReid, false, 'this is the colour path');
  assert.ok(m.score < 0.2, `a stranger should score nowhere near a match, got ${m.score}`);
  assert.equal(m.accepted, false, 'closed set must not name the best of a field of non-matches');
  assert.equal(m.reason, 'score');
});

test('closed set still waives the colour path\'s corroborating gates for a real match', () => {
  // The floor is the only gate the closed set keeps. `shape` is deliberately wrong here - a very
  // differently proportioned box - so `rejectionReason` says 'shape', which open-set would refuse
  // and closed-set must not: the per-part minimums exist to prop up a weak signal in a room that
  // may contain bystanders, and a closed set has none.
  const colourOnly = rexGallery({ reid: null });
  const gallery = colourOnly[0].gallery[0];
  const sameClothes = { ...gallery, shape: [0.6, 0.9] };
  const m = matchGallery(sameClothes, colourOnly, null, { closedSet: true, includeRejected: true });
  assert.ok(m.score >= 0.54, `the colours agree, so the score must clear the floor, got ${m.score}`);
  assert.equal(m.reason, 'shape', 'open-set would have refused this one');
  assert.equal(m.accepted, true, 'but a closed set waives the corroborating gates');
});

test('a distant stranger is not named on the colour path even once the gate admits them', () => {
  // The two halves together, through the real pixel path: a box the new gate admits, a room with
  // no re-identification anywhere (OSNet failed to load), and a person who is not the enrolled
  // player. Before the floor was restored this track got a name.
  const other = bands({ head: [120, 120, 120], shirt: [40, 90, 200], accent: [40, 90, 200], trousers: [220, 210, 190] });
  const scene = frame([{ box: FAR_STANDING, paint: other }], VIDEO);
  const tracker = new Tracker();
  const players = rexGallery({ reid: null });
  let track;
  for (let i = 0; i < 12; i++) {
    track = tracker.update([{ ...FAR_STANDING }], scene, players, 'self', 1000 + i * 300, { closedSet: true, includeRejected: true })[0];
  }
  assert.ok(track.rankings.length, 'the box is inside the gate, so it is scored');
  assert.equal(track.playerId, null, 'but a stranger at 20 m must not be named');
});

// ---- Retune tripwire ----

test('the exported thresholds are the values they were tuned at', () => {
  // tools/shape-evaluation.mjs used to mirror these by value, so retuning one silently invalidated
  // the harness; they are exported now. Asserted as literals, separately from the behaviour tests
  // above, so a deliberate retune has to come past this line and update the docs.
  assert.equal(MIN_SHAPE_SCORE, 0.36);
  assert.equal(EVIDENCE_MIN_PART, 0.24);
  assert.equal(EVIDENCE_MIN_SCORE, 0.42);
});
