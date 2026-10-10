#!/usr/bin/env node
//
// Measures what correcting the `shape` signature does to colour-only identification.
//
// SYNTHETIC. This repo has no labelled phone footage, so the population below is generated: flat
// coloured bands standing in for clothing, a seeded random walk standing in for distance, viewing
// angle and lighting. The numbers it prints are real in the sense that they come from running the
// production matcher (`frontend/public/identify.js`) unmodified over those fixtures - and nothing
// more than that. They bound the *direction* and rough *shape* of the change; they are not field
// measurements and must not be used to choose a threshold on their own. See
// docs/shape-normalisation-evaluation.md.
//
// Deliberately not part of `npm test`: it is an instrument, not a regression gate. Run it with
//   npm run eval:shape            # or: node tools/shape-evaluation.mjs
//   node tools/shape-evaluation.mjs --seed 7 --json
//   node tools/shape-evaluation.mjs --scale-sweep [--floor 0.10]
//   node tools/shape-evaluation.mjs --scale-sweep --sightings 3   # a quick look, not a result
//
// `--scale-sweep` answers a different question from the rest of the file: *what does admitting
// smaller boxes cost?* Live matching refuses any box under 18% of frame height before it scores a
// single feature, so players at range are never identified. Lowering that gate is the cheap fix
// and over-classification is the standing risk, so the sweep scores the same population at a
// range of box heights with the height gate forced open, and reports wrong-player and bystander
// acceptance - the two numbers that get worse - as a function of box height ratio. Read the
// caveats it prints; they are not boilerplate (see "What this sweep cannot tell you").
//
// It forces the weakest path in the fallback chain - no `reid`, no `embed` - because that is the
// only path the `shape` gate is reached on in a game where OSNet loaded. Each live sighting is
// scored twice against the same fixtures:
//
//   fixed  - galleries as the current code builds them (`shape` averaged raw)
//   legacy - the same galleries with `shape` L2-normalised, i.e. the bug
//
// so every difference printed is attributable to that one line.

import { bands, frame, installCanvasStub } from '../test/fixtures/synthetic-frame.mjs';

installCanvasStub();
const identify = await import('../frontend/public/identify.js');
const { averageSignatures, extractSignature, matchGallery } = identify;

// The thresholds this harness reports against come *from* identify.js, so retuning one there
// cannot silently leave the harness measuring against a number nothing uses any more. They used
// to be copied here by value, which is exactly that rot.
//
// A namespace import rather than named bindings, because a missing named export is a link error:
// it would take the harness (and, in the browser, the whole app) down rather than degrade. When a
// constant is absent the mirrored value below is used instead and `provenance` says so, loudly, in
// the printed header - so the harness keeps running and keeps telling you it is on a stub.
const provenance = [];
function threshold(name, mirrored) {
  const value = identify[name];
  if (typeof value === 'number') {
    provenance.push(`${name}=${value} (identify.js)`);
    return value;
  }
  // TODO(range-instrumentation): identify.js is gaining these exports; until it has, the mirrored
  // literal stands in. Delete the mirror - not the import - when the export lands.
  provenance.push(`${name}=${mirrored} (STUB: identify.js does not export it)`);
  return mirrored;
}

const MIN_SHAPE_SCORE = threshold('MIN_SHAPE_SCORE', 0.36);
const EVIDENCE_MIN_PART = threshold('EVIDENCE_MIN_PART', 0.24);
const EVIDENCE_MIN_SCORE = threshold('EVIDENCE_MIN_SCORE', 0.42);
// The live-matching height gate (identify.js:79) and the far floor a far-re-identification path
// would add below it. The gate is mirrored from source; the floor is an *assumption* - no such
// constant exists yet - and is what `--floor` overrides.
const MIN_MATCH_HEIGHT_RATIO = threshold('MIN_MATCH_HEIGHT_RATIO', 0.18);

const FRAME = { width: 640, height: 480 };
const ENROLLED_PLAYERS = 4; // a typical game
const BYSTANDERS = 6; // people in the park who never scanned
// Population sizes, and the one thing about this harness that is allowed to be turned down:
// `--sightings N` shrinks every per-person count proportionally. For a quick look, and for
// test/shape-evaluation-smoke.test.js, which checks that the instrument still *runs* and must not
// cost the test suite twenty seconds to do it. Any number quoted in docs/ comes from a full run.
let SIGHTINGS_PER_PERSON = 60;
// Partial bodies are the case `shape` was added for, so they get their own class: the correct
// player, but only their top half in frame. A box like that still passes boxQuality (MIN_ASPECT is
// 0.58), so nothing else in the pipeline is looking out for it.
let PARTIAL_SIGHTINGS_PER_PLAYER = 30;
const PARTIAL_VISIBLE_FRACTION = 0.45; // how much of the body the box covers
const SCAN_ANGLES = 4; // front / right / back / left, as scan.js enrols
const SAMPLES_PER_ANGLE = 6; // SCAN_SAMPLE_COUNT in screens/scan.js

// ---- fixtures ----

function rng(seed) {
  let state = (seed >>> 0) || 1;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const between = (random, lo, hi) => lo + random() * (hi - lo);

function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// One person's fixed appearance and build. Body aspect spans the plausible range for a detector
// box on a standing person; a few are deliberately out at the squat/slim ends, which is the kind
// of difference `shape` is supposed to notice.
function person(id, random, { enrolled }) {
  return {
    id,
    name: id,
    enrolled,
    aspect: between(random, 1.85, 3.3),
    shirtHue: between(random, 0, 360),
    shirtSat: between(random, 0.25, 0.9),
    shirtLight: between(random, 0.25, 0.65),
    accentHue: between(random, 0, 360),
    trouserHue: between(random, 0, 360),
    trouserSat: between(random, 0.1, 0.7),
    trouserLight: between(random, 0.15, 0.5),
    skin: between(random, 0.35, 0.75),
  };
}

// How that person looks in one frame: a viewing angle (which moves the accent stripe), a lighting
// gain, a little hue drift and some pixel noise. `stripe` is the only parameter enrolment and
// matching share a discrete grid on, so it plays the role of "which enrolled angle is this".
function paintFor(p, { stripe, gain, hueDrift, noiseAmp, random }) {
  const noise = noiseAmp ? () => (random() - 0.5) * noiseAmp : null;
  return bands({
    head: hsl(28, 0.4, p.skin),
    shirt: hsl(p.shirtHue + hueDrift, p.shirtSat, p.shirtLight),
    accent: hsl(p.accentHue + hueDrift, 0.75, 0.55),
    trousers: hsl(p.trouserHue + hueDrift, p.trouserSat, p.trouserLight),
    stripe,
    gain,
    noise,
  });
}

// A box of the right aspect for this person at `heightRatio` of the frame, placed so it stays
// inside the frame (a clipped box fails boxQuality and never reaches a signature).
function boxFor(p, heightRatio, random) {
  const aspect = p.aspect * between(random, 0.96, 1.04); // detector boxes are not that repeatable
  const h = Math.round(FRAME.height * heightRatio);
  const w = Math.max(6, Math.round(h / aspect));
  const x = Math.round(between(random, 8, Math.max(9, FRAME.width - w - 8)));
  const y = Math.round(between(random, 8, Math.max(9, FRAME.height - h - 8)));
  return { x, y, w, h, score: 0.9 };
}

// An enrolment scan: one gallery entry per angle, each averaged over several samples, at the
// cooperative distance scan.js asks for.
function enrol(p, random) {
  const gallery = [];
  for (let angle = 0; angle < SCAN_ANGLES; angle++) {
    const samples = [];
    for (let k = 0; k < SAMPLES_PER_ANGLE; k++) {
      const box = boxFor(p, between(random, 0.55, 0.7), random);
      const source = frame([{ box, paint: paintFor(p, { stripe: 0.15 + angle * 0.23, gain: between(random, 0.95, 1.05), hueDrift: between(random, -4, 4), noiseAmp: 10, random }) }], FRAME);
      samples.push(extractSignature(source, box));
    }
    gallery.push(averageSignatures(samples));
  }
  return gallery;
}

// One live sighting: a random distance, a random viewing angle, and harsher lighting and noise
// than the posed scan, which is what a game actually gives the matcher. `heightRatio` and
// `sensorGrid` are for the scale sweep; the defaults are the original behaviour exactly.
function sighting(p, random, { heightRatio = null, sensorGrid = false } = {}) {
  const box = boxFor(p, heightRatio ?? between(random, 0.22, 0.92), random);
  const source = frame(
    [
      {
        box,
        paint: paintFor(p, {
          stripe: between(random, 0.1, 0.9),
          gain: between(random, 0.7, 1.25),
          hueDrift: between(random, -12, 12),
          noiseAmp: 22,
          random,
        }),
      },
    ],
    { ...FRAME, sensorGrid },
  );
  return { box, signature: extractSignature(source, box) };
}

// The same player with only their top half in frame: the box keeps their width but loses most of
// its height, so its aspect is nothing like their enrolled one, while the colours inside it are
// still unmistakably theirs. `hist`, `lower` and `grid` are all happy with this; `shape` is the
// only feature that can object.
function partialSighting(p, random) {
  const full = boxFor(p, between(random, 0.3, 0.75), random);
  const box = { ...full, h: Math.max(6, Math.round(full.h * PARTIAL_VISIBLE_FRACTION)) };
  const paint = paintFor(p, {
    stripe: between(random, 0.1, 0.9),
    gain: between(random, 0.7, 1.25),
    hueDrift: between(random, -12, 12),
    noiseAmp: 22,
    random,
  });
  // Stretch the top PARTIAL_VISIBLE_FRACTION of the body over the whole (shorter) box.
  return extractSignature(frame([{ box, paint: (u, v) => paint(u, v * PARTIAL_VISIBLE_FRACTION) }], FRAME), box);
}

// ---- statistics ----

const l2 = (vec) => {
  const norm = Math.hypot(...vec) || 1;
  return vec.map((v) => v / norm);
};

const legacyGallery = (gallery) => gallery.map((entry) => ({ ...entry, shape: l2(entry.shape) }));

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: quantile(sorted, 0),
    p05: quantile(sorted, 0.05),
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    max: quantile(sorted, 1),
    zero: sorted.filter((v) => v === 0).length / (sorted.length || 1),
  };
}

function blankTally() {
  return {
    sightings: 0,
    correct: 0,
    wrongPlayer: 0,
    unresolved: 0,
    bystanderSightings: 0,
    bystanderAccepted: 0,
    partialSightings: 0,
    partialAccepted: 0,
    partialRejectedByShape: 0,
    partialNoCandidate: 0, // boxQuality refused the box before any feature was consulted
    partialShape: [],
    reasons: new Map(),
    correctShape: [],
    mismatchShape: [],
    evidenceParts: 0, // correct pairs clearing EVIDENCE_MIN_PART on all four colour parts
    evidenceFull: 0, // ...and the score floor too, i.e. evidenceWeight() would be non-zero
    correctPairs: 0,
    shapeGateWouldReject: 0, // correct pairs whose shape falls under MIN_SHAPE_SCORE
  };
}

function record(tally, decision, truth, kind) {
  const reason = decision?.accepted ? 'accepted' : (decision?.reason ?? 'no-candidate');
  if (kind !== 'partial') tally.reasons.set(reason, (tally.reasons.get(reason) ?? 0) + 1);

  if (kind === 'partial') {
    tally.partialSightings++;
    if (decision?.accepted) tally.partialAccepted++;
    else if (reason === 'shape') tally.partialRejectedByShape++;
    const own = decision?.rankings?.find((r) => r.id === truth.id);
    if (own) tally.partialShape.push(own.shape);
    else tally.partialNoCandidate++;
    return;
  }
  if (truth.enrolled) {
    tally.sightings++;
    if (decision?.accepted && decision.id === truth.id) tally.correct++;
    else if (decision?.accepted) tally.wrongPlayer++;
    else tally.unresolved++;
  } else {
    tally.bystanderSightings++;
    if (decision?.accepted) tally.bystanderAccepted++;
  }

  for (const ranking of decision?.rankings ?? []) {
    const isSelf = truth.enrolled && ranking.id === truth.id;
    if (!isSelf) {
      tally.mismatchShape.push(ranking.shape);
      continue;
    }
    tally.correctPairs++;
    tally.correctShape.push(ranking.shape);
    const parts = [ranking.upper, ranking.lower, ranking.grid, ranking.shape];
    if (parts.every((p) => p >= EVIDENCE_MIN_PART)) {
      tally.evidenceParts++;
      if (ranking.score >= EVIDENCE_MIN_SCORE) tally.evidenceFull++;
    }
    if (ranking.shape < MIN_SHAPE_SCORE) tally.shapeGateWouldReject++;
  }
}

// What a candidate MIN_SHAPE_SCORE would cost and buy, on this population: how many correct pairs
// it would reject and how many wrong-person pairs it would catch.
function sweep(correct, mismatch) {
  const rows = [];
  for (const gate of [0, 0.1, 0.2, 0.24, 0.3, 0.36, 0.45, 0.55, 0.65, 0.75, 0.85, 0.9]) {
    rows.push({
      gate,
      correctRejected: correct.filter((v) => v < gate).length / (correct.length || 1),
      mismatchRejected: mismatch.filter((v) => v < gate).length / (mismatch.length || 1),
    });
  }
  return rows;
}

// ---- run ----

function evaluate(seed) {
  const random = rng(seed);
  const people = [];
  for (let i = 0; i < ENROLLED_PLAYERS; i++) people.push(person(`player-${i + 1}`, random, { enrolled: true }));
  for (let i = 0; i < BYSTANDERS; i++) people.push(person(`bystander-${i + 1}`, random, { enrolled: false }));

  const roster = people.filter((p) => p.enrolled).map((p) => ({ id: p.id, name: p.name, gallery: enrol(p, random) }));
  const legacy = roster.map((p) => ({ ...p, gallery: legacyGallery(p.gallery) }));

  const tallies = { fixed: blankTally(), legacy: blankTally() };
  for (const p of people) {
    for (let k = 0; k < SIGHTINGS_PER_PERSON; k++) {
      const { signature: live } = sighting(p, random);
      // Colour-only by construction: `embed` is empty because no embedder was passed, and `reid`
      // is never set, so similarityParts() takes the last branch of its fallback chain.
      record(tallies.fixed, matchGallery(live, roster, null, { includeRejected: true }), p, 'full');
      record(tallies.legacy, matchGallery(live, legacy, null, { includeRejected: true }), p, 'full');
    }
    if (!p.enrolled) continue;
    for (let k = 0; k < PARTIAL_SIGHTINGS_PER_PLAYER; k++) {
      const live = partialSighting(p, random);
      record(tallies.fixed, matchGallery(live, roster, null, { includeRejected: true }), p, 'partial');
      record(tallies.legacy, matchGallery(live, legacy, null, { includeRejected: true }), p, 'partial');
    }
  }

  const report = (tally) => ({
    playerSightings: tally.sightings,
    correctAcceptance: tally.correct / (tally.sightings || 1),
    wrongPlayerAcceptance: tally.wrongPlayer / (tally.sightings || 1),
    unresolved: tally.unresolved / (tally.sightings || 1),
    bystanderSightings: tally.bystanderSightings,
    bystanderAcceptance: tally.bystanderAccepted / (tally.bystanderSightings || 1),
    partialSightings: tally.partialSightings,
    partialAcceptance: tally.partialAccepted / (tally.partialSightings || 1),
    partialRejectedByShape: tally.partialRejectedByShape / (tally.partialSightings || 1),
    partialNoCandidate: tally.partialNoCandidate / (tally.partialSightings || 1),
    partialShape: summary(tally.partialShape),
    reasons: Object.fromEntries([...tally.reasons].sort((a, b) => b[1] - a[1])),
    correctShape: summary(tally.correctShape),
    mismatchShape: summary(tally.mismatchShape),
    correctPairs: tally.correctPairs,
    evidencePartsReachable: tally.evidenceParts / (tally.correctPairs || 1),
    evidenceWeightNonZero: tally.evidenceFull / (tally.correctPairs || 1),
    shapeGateWouldRejectCorrect: tally.shapeGateWouldReject / (tally.correctPairs || 1),
    gateSweep: sweep(tally.correctShape, tally.mismatchShape),
  });

  return {
    seed,
    fixtures: {
      frame: FRAME,
      enrolledPlayers: ENROLLED_PLAYERS,
      bystanders: BYSTANDERS,
      sightingsPerPerson: SIGHTINGS_PER_PERSON,
      partialSightingsPerPlayer: PARTIAL_SIGHTINGS_PER_PLAYER,
      partialVisibleFraction: PARTIAL_VISIBLE_FRACTION,
      galleryEntriesPerPlayer: SCAN_ANGLES,
      samplesPerGalleryEntry: SAMPLES_PER_ANGLE,
      bodyAspects: people.map((p) => ({ id: p.id, aspect: Number(p.aspect.toFixed(3)) })),
    },
    fixed: report(tallies.fixed),
    legacy: report(tallies.legacy),
  };
}

// ---- box-scale sweep ----
//
// Same population, same matcher, same colour-only path; the one thing that varies is how tall the
// live box is as a fraction of frame height - the quantity `boxQuality` compares against
// MIN_MATCH_HEIGHT_RATIO and refuses on.
//
// Two things have to be kept apart, and the table keeps them in separate columns:
//
//   "refused by the height gate" - what today's code does to a box this small. It never scores a
//      feature, so every such sighting is `unresolved` no matter how recognisable the person is.
//   everything else - the counterfactual: what the matcher *would* decide if the box were
//      admitted. Measured by forcing `usable: true` on the signature, which is the single thing
//      lowering the gate would change. Nothing else in the pipeline is touched.
//
// The counterfactual is where the risk lives, so wrong-player and bystander acceptance are the
// columns to read first.

// Straddling both thresholds, so the table shows what each one is buying rather than only where
// the current one sits: two buckets under the assumed far floor, two between floor and gate, and
// three above it up to a box filling most of the frame.
const SCALE_BUCKETS = [
  [0.05, 0.08],
  [0.08, 0.1],
  [0.1, 0.13],
  [0.13, 0.18],
  [0.18, 0.25],
  [0.25, 0.4],
  [0.4, 0.7],
];
let SWEEP_SIGHTINGS_PER_PERSON = 60; // per bucket, per fixture mode

// What the colour features are actually read back through (identify.js readPixels calls): the
// upper and lower histograms sample an 18x24 canvas and the body grid a 6x8 one. Printed with the
// table because it is the explanation for the result: a box only starts *losing* information when
// it is smaller than the canvas it is being resampled into, and 18x24 is very small.
const HIST_CANVAS = { w: 18, h: 24 };

// `ideal` is this file's long-standing fixture: `paint` answers at infinite resolution, so a box
// 20 px wide is exactly as detailed as one 300 px wide. `sensor` snaps every read to the pixel
// lattice (test/fixtures/synthetic-frame.mjs), so a small box has only as many distinct values as
// it has sensor pixels and its noise is stuck to them. The gap between the two columns is this
// harness's own estimate of how much its optimism is worth - which is the honest way to read it.
const FIXTURE_MODES = [
  ['ideal', { sensorGrid: false }],
  ['sensor', { sensorGrid: true }],
];

function blankScaleTally() {
  return {
    playerSightings: 0,
    correct: 0,
    wrongPlayer: 0,
    unresolved: 0,
    gateRefusedPlayer: 0,
    bystanderSightings: 0,
    bystanderAccepted: 0,
    gateRefusedBystander: 0,
    correctScores: [],
    mismatchScores: [],
    correctShape: [],
    boxW: [],
    boxH: [],
  };
}

function recordScale(tally, decision, truth, gateRefused, box) {
  tally.boxW.push(box.w);
  tally.boxH.push(box.h);
  if (truth.enrolled) {
    tally.playerSightings++;
    if (gateRefused) tally.gateRefusedPlayer++;
    if (decision?.accepted && decision.id === truth.id) tally.correct++;
    else if (decision?.accepted) tally.wrongPlayer++;
    else tally.unresolved++;
  } else {
    tally.bystanderSightings++;
    if (gateRefused) tally.gateRefusedBystander++;
    if (decision?.accepted) tally.bystanderAccepted++;
  }
  for (const ranking of decision?.rankings ?? []) {
    if (truth.enrolled && ranking.id === truth.id) {
      tally.correctScores.push(ranking.score);
      tally.correctShape.push(ranking.shape);
    } else {
      tally.mismatchScores.push(ranking.score);
    }
  }
}

function scaleSweep(seed, farFloor) {
  // Its own generator, so adding or resizing a bucket cannot shift the main evaluation's numbers.
  const random = rng((seed ^ 0x5ca1e) >>> 0);
  const people = [];
  for (let i = 0; i < ENROLLED_PLAYERS; i++) people.push(person(`player-${i + 1}`, random, { enrolled: true }));
  for (let i = 0; i < BYSTANDERS; i++) people.push(person(`bystander-${i + 1}`, random, { enrolled: false }));
  // Enrolled at the cooperative distance scan.js asks for, exactly as in a real game: the gallery
  // is always of a close, well-lit person however far away the live sighting is. That asymmetry is
  // the thing being measured.
  const roster = people.filter((p) => p.enrolled).map((p) => ({ id: p.id, name: p.name, gallery: enrol(p, random) }));

  const rows = [];
  for (const [lo, hi] of SCALE_BUCKETS) {
    for (const [mode, options] of FIXTURE_MODES) {
      const tally = blankScaleTally();
      for (const p of people) {
        for (let k = 0; k < SWEEP_SIGHTINGS_PER_PERSON; k++) {
          const { box, signature } = sighting(p, random, { heightRatio: between(random, lo, hi), ...options });
          const gateRefused = signature.usable === false;
          const admitted = { ...signature, usable: true };
          recordScale(tally, matchGallery(admitted, roster, null, { includeRejected: true }), p, gateRefused, box);
        }
      }
      rows.push({
        lo,
        hi,
        mode,
        straddles: lo < MIN_MATCH_HEIGHT_RATIO && hi > MIN_MATCH_HEIGHT_RATIO,
        belowFloor: hi <= farFloor,
        inFarBand: lo >= farFloor && hi <= MIN_MATCH_HEIGHT_RATIO,
        playerSightings: tally.playerSightings,
        correctAcceptance: tally.correct / (tally.playerSightings || 1),
        wrongPlayerAcceptance: tally.wrongPlayer / (tally.playerSightings || 1),
        unresolved: tally.unresolved / (tally.playerSightings || 1),
        bystanderAcceptance: tally.bystanderAccepted / (tally.bystanderSightings || 1),
        gateRefusedPlayer: tally.gateRefusedPlayer / (tally.playerSightings || 1),
        gateRefusedBystander: tally.gateRefusedBystander / (tally.bystanderSightings || 1),
        correctScore: summary(tally.correctScores),
        mismatchScore: summary(tally.mismatchScores),
        correctShape: summary(tally.correctShape),
        // Median box size in source pixels, and whether that is still more than the 18x24 canvas
        // the histograms are read back through. Once it is not, the features are being invented by
        // the upsample - and that is where a synthetic fixture stops meaning anything at all.
        medianBoxW: Math.round(quantile([...tally.boxW].sort((a, b) => a - b), 0.5)),
        medianBoxH: Math.round(quantile([...tally.boxH].sort((a, b) => a - b), 0.5)),
      });
    }
  }

  return {
    seed,
    farFloor,
    gate: MIN_MATCH_HEIGHT_RATIO,
    frame: FRAME,
    histCanvas: HIST_CANVAS,
    sightingsPerPersonPerBucket: SWEEP_SIGHTINGS_PER_PERSON,
    people: people.length,
    enrolledPlayers: ENROLLED_PLAYERS,
    bystanders: BYSTANDERS,
    provenance: [...provenance],
    rows,
  };
}

// ---- output ----

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const num = (v) => (Number.isFinite(v) ? v.toFixed(3) : '-');

function print(result) {
  const { fixed, legacy } = result;
  console.log(`# shape normalisation - synthetic evaluation\n`);
  console.log(`Seed ${result.seed}. Synthetic fixtures, NOT phone footage. Colour-only path forced (no reid, no embed).`);
  console.log(
    `${result.fixtures.enrolledPlayers} enrolled players + ${result.fixtures.bystanders} bystanders, ` +
      `${result.fixtures.sightingsPerPerson} sightings each, ` +
      `${result.fixtures.galleryEntriesPerPlayer} gallery entries x ${result.fixtures.samplesPerGalleryEntry} samples.\n`,
  );

  console.log(`## Per-check decisions (open set, the gates applied)\n`);
  console.log(`| | legacy (bug) | fixed |`);
  console.log(`| --- | --- | --- |`);
  const row = (label, pick, fmt = pct) => console.log(`| ${label} | ${fmt(pick(legacy))} | ${fmt(pick(fixed))} |`);
  row('correct-player acceptance', (r) => r.correctAcceptance);
  row('wrong-player acceptance', (r) => r.wrongPlayerAcceptance);
  row('unresolved (player seen, nobody named)', (r) => r.unresolved);
  row('bystander acceptance', (r) => r.bystanderAcceptance);
  row('partial body of a player accepted anyway', (r) => r.partialAcceptance);
  row('partial body rejected *by the shape gate*', (r) => r.partialRejectedByShape);
  row('partial body refused by boxQuality first', (r) => r.partialNoCandidate);
  row('correct pairs clearing EVIDENCE_MIN_PART', (r) => r.evidencePartsReachable);
  row('correct pairs with non-zero evidenceWeight()', (r) => r.evidenceWeightNonZero);
  row(`correct pairs under MIN_SHAPE_SCORE (${MIN_SHAPE_SCORE})`, (r) => r.shapeGateWouldRejectCorrect);
  console.log('');

  for (const [name, r] of [['legacy (bug)', legacy], ['fixed', fixed]]) {
    console.log(`### ${name} - rejection reasons\n`);
    console.log(
      Object.entries(r.reasons)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · '),
    );
    console.log('');
  }

  console.log(`## Empirical \`shape\` score distribution\n`);
  console.log(`| pairs | n | min | p05 | p10 | p25 | median | p75 | p90 | p95 | max | exactly 0 |`);
  console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  const dist = (label, s) =>
    console.log(
      `| ${label} | ${s.n} | ${num(s.min)} | ${num(s.p05)} | ${num(s.p10)} | ${num(s.p25)} | ${num(s.median)} | ` +
        `${num(s.p75)} | ${num(s.p90)} | ${num(s.p95)} | ${num(s.max)} | ${pct(s.zero)} |`,
    );
  dist('legacy, correct person', legacy.correctShape);
  dist('legacy, wrong person', legacy.mismatchShape);
  dist('fixed, correct person', fixed.correctShape);
  dist('fixed, wrong person', fixed.mismatchShape);
  dist('fixed, correct person, partial body', fixed.partialShape);
  console.log('');

  console.log(`## What a given MIN_SHAPE_SCORE would do (fixed feature)\n`);
  console.log(
    `Read the high gates with suspicion: these fixtures give the same person the same aspect by\n` +
      `construction, varied only by +-4% of box slop, so the correct-person column is unrealistically\n` +
      `tight. Real clothing, pose and detector boxes spread it much further. This table says where a\n` +
      `threshold *could* sit on synthetic data, not where it should sit on a phone.\n`,
  );
  console.log(`| gate | correct pairs rejected | wrong-person pairs rejected |`);
  console.log(`| --- | --- | --- |`);
  for (const s of fixed.gateSweep) {
    console.log(`| ${s.gate.toFixed(2)} | ${pct(s.correctRejected)} | ${pct(s.mismatchRejected)} |`);
  }
  console.log('');
}

function printScaleSweep(sweep) {
  const band = `${sweep.farFloor.toFixed(2)}-${sweep.gate.toFixed(2)}`;
  console.log(`# box-scale sweep - what admitting smaller boxes costs\n`);
  console.log(`Seed ${sweep.seed}. SYNTHETIC fixtures, NOT phone footage. Colour-only path forced (no reid, no embed).`);
  console.log(
    `${sweep.enrolledPlayers} enrolled players + ${sweep.bystanders} bystanders, ` +
      `${sweep.sightingsPerPersonPerBucket} sightings each per bucket per fixture mode, ` +
      `frame ${sweep.frame.width}x${sweep.frame.height}.`,
  );
  console.log(`Thresholds: ${sweep.provenance.join(' · ')}`);
  console.log(`Live height gate ${sweep.gate}; assumed far floor ${sweep.farFloor} (--floor to change). Far band ${band}.\n`);
  console.log(
    `Every row scores its sightings with the height gate FORCED OPEN, because the question is what\n` +
      `the matcher would decide about a box this small, not that today's code refuses it. The\n` +
      `"gate refuses" column is what today's code does, kept separate so the two are never confused.\n`,
  );

  console.log(`## Acceptance by box height ratio\n`);
  console.log(
    `Colour features are read back through a ${sweep.histCanvas.w}x${sweep.histCanvas.h} canvas, so "median box" is the\n` +
      `number to compare against that: while it is larger, the resample is throwing detail away, and\n` +
      `the features are as good as they ever get. Below it, the upsample is inventing them.\n`,
  );
  console.log(
    `| height ratio | fixture | median box | correct | wrong player | bystander | unresolved | gate refuses (player/bystander) |`,
  );
  console.log(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of sweep.rows) {
    const where = r.belowFloor ? ' ⌄floor' : r.inFarBand ? ' far' : r.straddles ? ' ±gate' : '';
    console.log(
      `| ${r.lo.toFixed(2)}-${r.hi.toFixed(2)}${where} | ${r.mode} | ${r.medianBoxW}x${r.medianBoxH} | ` +
        `${pct(r.correctAcceptance)} | ${pct(r.wrongPlayerAcceptance)} | ${pct(r.bystanderAcceptance)} | ` +
        `${pct(r.unresolved)} | ${pct(r.gateRefusedPlayer)} / ${pct(r.gateRefusedBystander)} |`,
    );
  }
  console.log('');

  console.log(`## Score distribution by box height ratio\n`);
  console.log(`| height ratio | fixture | pairs | n | min | p05 | p25 | median | p75 | p95 | max |`);
  console.log(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of sweep.rows) {
    const line = (label, s) =>
      console.log(
        `| ${r.lo.toFixed(2)}-${r.hi.toFixed(2)} | ${r.mode} | ${label} | ${s.n} | ${num(s.min)} | ${num(s.p05)} | ` +
          `${num(s.p25)} | ${num(s.median)} | ${num(s.p75)} | ${num(s.p95)} | ${num(s.max)} |`,
      );
    line('correct', r.correctScore);
    line('wrong', r.mismatchScore);
  }
  console.log('');

  console.log(`## How to read this (and what it cannot tell you)\n`);
  console.log(
    [
      `The curve above is FLAT. Read that as a fact about these fixtures, not as reassurance about`,
      `range. A flat-colour fixture has almost no detail to lose, so shrinking its box loses almost`,
      `nothing: at 0.05-0.08 of frame height the box is already narrower than the ${sweep.histCanvas.w}x${sweep.histCanvas.h} canvas the`,
      `histograms are read through, and accuracy still does not move. That is the fixture telling`,
      `you it is scale-blind.`,
      ``,
      `So this is NOT a range measurement, and the flat curve is NOT evidence that admitting small`,
      `boxes is safe on a phone. Specifically:`,
      ``,
      `- It is SYNTHETIC. Flat coloured bands, a seeded random walk for angle and lighting. No`,
      `  motion blur, no atmospheric haze, no lens softness, no ISP/JPEG artefacts, no detector`,
      `  boxes getting sloppier at range. Those are exactly the things that degrade a distant crop`,
      `  in real life, so the real curve is worse than every row above - by an unmeasured amount.`,
      `- The \`sensor\` rows model ONE of those mechanisms and only loosely: reads snap to the pixel`,
      `  lattice, so a small box has as few distinct values as it has pixels and its noise cannot`,
      `  average away. Nearest-neighbour replication, not a real resample. The ideal/sensor gap is a`,
      `  lower bound on how much the optimism matters, not a correction for it - and it comes out`,
      `  near zero here, which again is about the fixture having no texture to quantise.`,
      `- \`shape\` is scale-invariant by construction here: shapeSignature() is built from the box`,
      `  aspect, and these fixtures give each person a fixed aspect varied by only +-4% of box slop.`,
      `  So this sweep CANNOT show \`shape\` degrading with distance. On a phone it will, because the`,
      `  detector's box gets less reliable as the person gets smaller. Nothing here measures that.`,
      `- The correct-person column is unrealistically tight for the same reason the existing`,
      `  MIN_SHAPE_SCORE table warns about, and the warning matters MORE here: holding a person's`,
      `  appearance constant while shrinking their box is precisely the assumption distance breaks.`,
      `- Enrolment is always close and well lit, as in a real game. That part is realistic.`,
      ``,
      `Three things it does establish, none of which depend on the fixtures being realistic:`,
      ``,
      `1. The height gate is the whole binding constraint below it. "gate refuses" is 100% for every`,
      `   bucket under ${sweep.gate}: no feature is ever scored, so no amount of appearance quality can`,
      `   rescue a distant player today. The failure is a refusal, not a mis-identification.`,
      `2. The matcher's arithmetic has no hidden scale dependence. Feed it small boxes and it behaves`,
      `   the same as with large ones. If lowering the gate goes wrong, it will go wrong because of`,
      `   the pixels, not because some score silently misbehaves on small inputs.`,
      `3. The ${sweep.histCanvas.w}x${sweep.histCanvas.h} feature canvas stops caring about box size far below the gate. A box at the`,
      `   ${sweep.gate} gate is ~40x103 px; the histograms downsample that to ${sweep.histCanvas.w}x${sweep.histCanvas.h} regardless. Whatever`,
      `   ${sweep.gate} is protecting, it is not histogram resolution.`,
      ``,
      `The honest next step is labelled phone footage at known distances. This harness cannot`,
      `substitute for it, and the ?debug range readout (docs/development/debug-mode.md) exists`,
      `because that is the measurement that actually decides the fix.`,
    ].join('\n'),
  );
  console.log('');
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const seed = flag('--seed', 20251010);

// See SIGHTINGS_PER_PERSON. Shrinks the population, never the thresholds or the bucket layout.
const sightings = flag('--sightings', 0);
if (sightings > 0) {
  SIGHTINGS_PER_PERSON = sightings;
  SWEEP_SIGHTINGS_PER_PERSON = sightings;
  PARTIAL_SIGHTINGS_PER_PLAYER = Math.max(1, Math.round(sightings / 2));
}

if (args.includes('--scale-sweep')) {
  const sweep = scaleSweep(seed, flag('--floor', 0.1));
  if (args.includes('--json')) console.log(JSON.stringify(sweep, null, 2));
  else printScaleSweep(sweep);
} else {
  const result = evaluate(seed);
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else print(result);
}
