// The long-range identification gate (frontend/public/identify.js).
//
// MIN_MATCH_HEIGHT_RATIO used to refuse a signature outright: `extractSignature` stamped
// `usable: false` and `bestAngleScore` returned null, so a player who filled less than 18% of
// frame height was never identified *at any score*. The far band relaxes that for signal 1 only -
// re-identification is the one signal trained across scales - and charges a stricter score for it.
//
// The whole safety argument rests on one property: at or above 0.18 nothing changed. These tests
// drive the real `extractSignature` through the resampling canvas stub, because the gate is read
// off the pixel geometry of a frame and the mocked-past tests could not see it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bands, frame, installCanvasStub } from './fixtures/synthetic-frame.mjs';

installCanvasStub();

const {
  Tracker,
  averageSignatures,
  extractSignature,
  matchGallery,
  rangeDiagnostics,
  resetRangeDiagnostics,
  MIN_MATCH_HEIGHT_RATIO,
  FAR_REID_MIN_HEIGHT_RATIO,
  FAR_REID_MIN_WIDTH_RATIO,
  FAR_REID_MAX_PENALTY,
  MIN_SHAPE_SCORE,
  EVIDENCE_MIN_PART,
  EVIDENCE_MIN_SCORE,
} = await import('../frontend/public/identify.js');

// 720p landscape: the frame the existing 0.18 was measured in (130 px of a 720 px frame), so the
// box heights below are the same arithmetic the constants were derived from.
const VIDEO = { width: 1280, height: 720 };
const PAINT = bands({ head: [196, 158, 130], shirt: [210, 60, 55], accent: [240, 196, 70], trousers: [40, 50, 120] });

// Height ratios are written out rather than computed from the constants: a test that derives its
// own expectation from the number it is guarding asserts x >= x.
const NEAR = { x: 100, y: 100, w: 120, h: 300, score: 0.9 }; // 0.417 of frame height
const AT_GATE = { x: 400, y: 200, w: 60, h: 129.6, score: 0.9 }; // exactly 0.18
const ABOVE_GATE = { x: 400, y: 200, w: 60, h: 150, score: 0.9 }; // 0.208
const BAND_NEAR = { x: 400, y: 300, w: 50, h: 125, score: 0.9 }; // 0.174 - just inside the band
const BAND_FAR = { x: 400, y: 300, w: 33, h: 82, score: 0.9 }; // 0.114 - close to the floor
const BELOW_FLOOR = { x: 500, y: 300, w: 24, h: 60, score: 0.9 }; // 0.083 - under it

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
function rexGallery({ reid = REX_REID, embed = null } = {}) {
  const entry = averageSignatures([extractSignature(sceneFor(NEAR), NEAR)]);
  if (reid) entry.reid = reid;
  if (embed) entry.embed = embed;
  return [{ id: 'rex', name: 'Rex', gallery: [entry] }];
}

// A live signature from the real pixel path, optionally carrying the embeddings the caller
// attaches (Tracker.update does this for `reid`).
function live(box, { reid = null, embed = null } = {}) {
  const signature = extractSignature(sceneFor(box), box);
  if (reid) signature.reid = reid;
  if (embed) signature.embed = embed;
  return signature;
}

const match = (signature, players = rexGallery()) =>
  matchGallery(signature, players, null, { includeRejected: true });

// The signature as a build before the far band existed produced it: `usable` and nothing else.
const asLegacy = ({ range, rangePenalty, ...rest }) => rest;

// ---- The classification itself ----

test('`usable` still means "passed boxQuality", and `range` carries why it did not', () => {
  // `usable` is extractSignature's published answer to "is this box worth a signature", and
  // screens/scan.js reads signatures built by the same function. The band deliberately does NOT
  // widen it - relaxing the gate is the change this one was written instead of - so a band box
  // reports usable: false and says 'far-reid' separately. Written as literal box geometry against
  // literal expectations, not derived from the constants.
  const expected = [
    [NEAR, 'ok', true], // 0.417 of frame height
    [AT_GATE, 'ok', true], // exactly 0.18
    [BAND_NEAR, 'far-reid', false], // 0.174
    [BAND_FAR, 'far-reid', false], // 0.114
    [BELOW_FLOOR, 'below-floor', false], // 0.083
    [PARTIAL_BODY, 'partial-body', false], // aspect 0.5
    [EDGE_CLIPPED, 'edge-clipped', false], // against the left edge
  ];
  for (const [box, range, usable] of expected) {
    const signature = live(box);
    assert.equal(signature.range, range, `${box.w}x${box.h} should be ${range}`);
    assert.equal(signature.usable, usable, `${box.w}x${box.h} should report usable: ${usable}`);
    if (range !== 'far-reid') assert.equal(signature.rangePenalty, 0, `${range} boxes are not penalised, they are refused`);
    else assert.ok(signature.rangePenalty > 0);
  }
});

// ---- Property 1: at or above 0.18, nothing changed ----

test('a box at exactly 0.18 scores, accepts and rejects identically to a pre-band signature', () => {
  // The non-negotiable one. The same pixels, matched twice: once with the new range fields on the
  // signature and once with them stripped, which is byte for byte what the old extractSignature
  // returned. Any divergence - score, accept, reason, part scores, rankings - is a regression at
  // the ranges that already work.
  for (const [label, box] of [
    ['at the gate', AT_GATE],
    ['above the gate', ABOVE_GATE],
    ['well inside', NEAR],
  ]) {
    for (const [flavour, options, players] of [
      ['colour only', {}, rexGallery({ reid: null })],
      ['re-identification', { reid: similarTo(REX_REID, 0.8) }, rexGallery()],
      ['re-identification, refused on score', { reid: similarTo(REX_REID, 0.5) }, rexGallery()],
      ['MobileNet embedding', { embed: unit(256, 21) }, rexGallery({ reid: null, embed: unit(256, 21) })],
    ]) {
      const signature = live(box, options);
      assert.equal(signature.usable, true, `${label}/${flavour}: the box must still pass the normal gate`);
      assert.equal(signature.range, 'ok');
      assert.equal(signature.rangePenalty, 0, `${label}/${flavour}: no penalty may be charged above the gate`);

      const now = match(signature, players);
      const before = match(asLegacy(signature), players);
      assert.deepStrictEqual(now, before, `${label}/${flavour}: the whole match must be unchanged`);
      assert.ok(
        now === null || !Object.hasOwn(now, 'rangePenalty'),
        `${label}/${flavour}: a match above the gate must not even carry a rangePenalty field`,
      );
    }
  }
});

test('0.18 remains the colour-only and MobileNet requirement', () => {
  // Property 4. A box just inside the band is refused outright - null, not a rejected ranking -
  // on both model-free paths, exactly as it was before. The gate-height control is what shows the
  // refusal is about range and not about these particular pixels.
  const colourOnly = rexGallery({ reid: null });
  assert.equal(match(live(BAND_NEAR), colourOnly), null, 'colour only, just inside the band');
  assert.equal(match(live(BAND_FAR), colourOnly), null, 'colour only, near the floor');
  assert.notEqual(match(live(AT_GATE), colourOnly), null, 'the same pixels at the gate are still ranked');

  const embed = unit(256, 31);
  const withEmbed = rexGallery({ reid: null, embed });
  assert.equal(match(live(BAND_FAR, { embed }), withEmbed), null, 'the MobileNet blend is no looser');
  assert.notEqual(match(live(AT_GATE, { embed }), withEmbed), null);
});

test('only the height gate relaxes, so a tall sliver stays refused', () => {
  // 0.347 of frame height but 44 px wide: it already fails MIN_BOX_WIDTH_RATIO, and a box that
  // narrow is a mis-detection or half a doorframe, not someone far away. Its aspect is legal
  // (5.7), so nothing downstream would catch it if the band let it in.
  const sliver = { x: 400, y: 150, w: 44, h: 250, score: 0.9 };
  const signature = live(sliver, { reid: similarTo(REX_REID, 0.95) });
  assert.equal(signature.range, 'below-floor', 'a box that failed on width is under the floor');
  assert.equal(signature.rangePenalty, 0);
  assert.equal(match(signature), null, 'and re-identification does not rescue it at any score');
});

// ---- Property 2: the band, re-identification only, against a stricter bar ----

test('a box in the band is identified when re-identification clears the stricter bar', () => {
  // 0.114 of frame height: about 16-19 m, where nothing was ever identified before.
  const m = match(live(BAND_FAR, { reid: similarTo(REX_REID, 0.8) }));
  assert.ok(m, 'the band must produce a ranking at all');
  assert.equal(m.id, 'rex');
  assert.equal(m.hasReid, true);
  assert.equal(m.accepted, true);
  assert.ok(Math.abs(m.score - 0.8) < 0.001, `the score is the cosine similarity, got ${m.score}`);
  assert.ok(m.rangePenalty > 0, 'and it is marked as having come through the band');
});

test('a band box between the normal threshold and the stricter bar is refused', () => {
  // 0.68 is comfortably above REID_DEFAULT_THRESHOLD (0.65) and below the bar this box earns
  // (0.65 + 0.059 = 0.709). The control is the same embedding at gate height: accepted there, so
  // what refuses it near the floor is the range, not the score.
  const reid = similarTo(REX_REID, 0.68);
  assert.equal(match(live(BAND_FAR, { reid }), rexGallery()), null, 'refused near the floor');

  const control = match(live(AT_GATE, { reid }), rexGallery());
  assert.ok(control, 'the same score is still a ranking at gate height');
  assert.equal(control.accepted, true, 'and accepted there');
  assert.ok(Math.abs(control.score - 0.68) < 0.001);
});

test('the penalty grows with the shortfall rather than stepping', () => {
  // A box a hair under 0.18 is charged almost nothing: 0.174 earns a bar of 0.6506, so 0.655 is
  // enough. The same score near the floor is not, because there the bar is 0.709. One continuous
  // curve, no cliff at the line and no cliff at the floor.
  const reid = similarTo(REX_REID, 0.655);
  const justInside = match(live(BAND_NEAR, { reid }), rexGallery());
  assert.ok(justInside, 'a box just inside the band is barely penalised');
  assert.equal(justInside.accepted, true);
  assert.ok(justInside.rangePenalty < 0.01, `and the penalty is tiny, got ${justInside.rangePenalty}`);

  assert.equal(match(live(BAND_FAR, { reid }), rexGallery()), null, 'the same score near the floor is not enough');

  // Monotone across the band, and still zero the instant the box passes the normal gate.
  const penalty = (box) => live(box, { reid }).rangePenalty;
  assert.equal(penalty(AT_GATE), 0);
  assert.ok(penalty(BAND_NEAR) > 0);
  assert.ok(penalty(BAND_FAR) > penalty(BAND_NEAR));
  assert.ok(penalty(BAND_FAR) < 0.11 + 1e-9, 'and bounded by the floor penalty');
});

test('a band box is still refused when only colours can score it', () => {
  // Property 2's "only when re-identification decided it". The live box carries an embedding but
  // the gallery angle does not, so hasReid is false and there is nothing to let it through.
  const live1 = live(BAND_FAR, { reid: similarTo(REX_REID, 0.95) });
  assert.equal(match(live1, rexGallery({ reid: null })), null, 'a gallery without re-identification');

  const live2 = live(BAND_FAR);
  assert.equal(match(live2, rexGallery()), null, 'a live signature without re-identification');
});

// ---- Property 3: below the floor, nothing is attempted and nothing is spent ----

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

test('a box under the floor is refused and costs no re-identification inference', () => {
  // The waste fix. A too-small box used to pay a full 128x256 OSNet inference on every check and
  // have the result thrown away at the usable gate.
  const strong = () => similarTo(REX_REID, 0.95);
  const below = driveOnce([BELOW_FLOOR], strong);
  assert.equal(below.reid.requests.length, 0, 'no inference may be spent under the floor');
  assert.equal(below.tracks[0].playerId, null, 'and it is not identified');

  // Specificity: the gate is the floor, not "anything that failed boxQuality". A box inside the
  // band, and one that passes outright, both still ask for an embedding.
  assert.equal(driveOnce([BAND_FAR], strong).reid.requests.length, 1, 'the band still embeds');
  assert.equal(driveOnce([NEAR], strong).reid.requests.length, 1, 'a normal box still embeds');
});

test('the stricter bar survives the tracker smoothing its scores', () => {
  // The band's bar is applied twice, and this is why the second one exists. A track decides on the
  // median of its last 3 s, so a player who was at gate height (bar 0.65) and walks into the band
  // (bar 0.709) carries forward scores that only had to clear the lower bar. Here the medians are
  // 0.62 then (0.62 + 0.75) / 2 = 0.685: over the plain threshold, under the bar this box earns.
  const scores = [0.62, 0.75];
  let check = 0;
  const reid = fakeReid(() => similarTo(REX_REID, scores[Math.min(check++, scores.length - 1)]));
  const tracker = new Tracker();
  const players = rexGallery();

  const step = (box, now) =>
    tracker.update([box], frame([person(box)], VIDEO), players, 'self', now, { reid, includeRejected: true })[0];

  const atGate = step(AT_GATE, 1000);
  assert.equal(atGate.rankings.length, 1, 'the gate-height check must rank Rex');

  // The same person, now in the band. Centred on the previous box so the tracker associates it
  // with the same track and the 0.62 stays in its history.
  const walkedAway = { x: 413.5, y: 223.8, w: BAND_FAR.w, h: BAND_FAR.h, score: 0.9 };
  const far = step(walkedAway, 1200);
  assert.equal(tracker.tracks.length, 1, 'it has to be the same track, or there is no history to smooth');

  const ranked = far.rankings[0];
  assert.ok(ranked, 'the raw 0.75 clears the bar, so the check is scored');
  assert.ok(Math.abs(ranked.score - 0.685) < 0.002, `the smoothed score should be the median, got ${ranked.score}`);
  assert.ok(Math.abs(ranked.rawScore - 0.75) < 0.002, 'and the raw check is kept beside it');
  assert.ok(far.debugMatch, 'a smoothed score under the band bar must be refused');
  assert.equal(far.debugMatch.reason, 'score');
  assert.equal(far.playerId, null);
});

// ---- Diagnostics ----

// One box per refusal reason, laid out so the tracker associates each with its own track.
const PARTIAL_BODY = { x: 600, y: 200, w: 300, h: 150, score: 0.9 }; // aspect 0.5
const EDGE_CLIPPED = { x: 0, y: 200, w: 80, h: 200, score: 0.9 }; // touching the left edge

test('the range diagnostics count each live check once, on the right path', () => {
  resetRangeDiagnostics();
  assert.deepStrictEqual(rangeDiagnostics(), {
    ok: 0,
    tooFar: 0,
    farReid: 0,
    belowFloor: 0,
    partialBody: 0,
    edgeClipped: 0,
  });

  // BAND_FAR is at x 400 and BAND_NEAR at x 400 too, so the two band boxes are told apart by
  // width: the near one gets a score that clears its bar, the far one gets one that does not.
  const strong = similarTo(REX_REID, 0.95);
  const weak = similarTo(REX_REID, 0.68); // over 0.65, under BAND_FAR's 0.709
  const vectorFor = (box) => (box.w === BAND_FAR.w ? weak : strong);

  const boxes = [NEAR, BAND_NEAR, BAND_FAR, BELOW_FLOOR, PARTIAL_BODY, EDGE_CLIPPED];
  const { tracks } = driveOnce(boxes, vectorFor);
  assert.equal(tracks.length, boxes.length, 'each box should get its own track');

  assert.deepStrictEqual(rangeDiagnostics(), {
    ok: 1, // NEAR
    tooFar: 1, // BAND_FAR: in the band, but 0.68 does not clear 0.709
    farReid: 1, // BAND_NEAR: in the band and through it
    belowFloor: 1, // BELOW_FLOOR
    partialBody: 1, // PARTIAL_BODY
    edgeClipped: 1, // EDGE_CLIPPED
  });

  // ...and the counters really are counts, not flags.
  driveOnce([NEAR], () => strong);
  assert.equal(rangeDiagnostics().ok, 2);

  // The accessor hands out a copy: a caller cannot zero the game's counters by writing to it.
  const snapshot = rangeDiagnostics();
  snapshot.ok = 999;
  assert.equal(rangeDiagnostics().ok, 2);

  resetRangeDiagnostics();
  assert.equal(rangeDiagnostics().ok, 0);
});

test('a band box that is refused for want of an embedding is still counted', () => {
  // The tracker gives up before matchGallery when re-identification has nothing for the track
  // yet, which is the commonest reason a far box goes unidentified. It must not fall out of the
  // readout.
  resetRangeDiagnostics();
  driveOnce([BAND_FAR], () => null);
  assert.deepStrictEqual(rangeDiagnostics(), {
    ok: 0,
    tooFar: 1,
    farReid: 0,
    belowFloor: 0,
    partialBody: 0,
    edgeClipped: 0,
  });
  resetRangeDiagnostics();
});

// ---- Retune tripwire ----

test('the exported thresholds are the values they were tuned at', () => {
  // tools/shape-evaluation.mjs used to mirror the first three by value, so retuning one silently
  // invalidated the harness; they are exported now. Asserted as literals, separately from the
  // behaviour tests above, so a deliberate retune has to come past this line and update the docs.
  assert.equal(MIN_SHAPE_SCORE, 0.36);
  assert.equal(EVIDENCE_MIN_PART, 0.24);
  assert.equal(EVIDENCE_MIN_SCORE, 0.42);
  assert.equal(MIN_MATCH_HEIGHT_RATIO, 0.18);
  assert.equal(FAR_REID_MIN_HEIGHT_RATIO, 0.09);
  assert.equal(FAR_REID_MIN_WIDTH_RATIO, 0.025);
  assert.equal(FAR_REID_MAX_PENALTY, 0.11);
});
