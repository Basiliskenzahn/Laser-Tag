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
const { averageSignatures, extractSignature, matchGallery } = await import('../frontend/public/identify.js');

// Mirrors of the constants under discussion. Imported by value rather than from identify.js, which
// does not export them; the point of the harness is to report against them, not to change them.
const MIN_SHAPE_SCORE = 0.36;
const EVIDENCE_MIN_PART = 0.24;
const EVIDENCE_MIN_SCORE = 0.42;

const FRAME = { width: 640, height: 480 };
const ENROLLED_PLAYERS = 4; // a typical game
const BYSTANDERS = 6; // people in the park who never scanned
const SIGHTINGS_PER_PERSON = 60;
// Partial bodies are the case `shape` was added for, so they get their own class: the correct
// player, but only their top half in frame. A box like that still passes boxQuality (MIN_ASPECT is
// 0.58), so nothing else in the pipeline is looking out for it.
const PARTIAL_SIGHTINGS_PER_PLAYER = 30;
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
// than the posed scan, which is what a game actually gives the matcher.
function sighting(p, random) {
  const box = boxFor(p, between(random, 0.22, 0.92), random);
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
    FRAME,
  );
  return extractSignature(source, box);
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
      const live = sighting(p, random);
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

const args = process.argv.slice(2);
const seedArg = args.indexOf('--seed');
const result = evaluate(seedArg >= 0 ? Number(args[seedArg + 1]) : 20251010);
if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
else print(result);
