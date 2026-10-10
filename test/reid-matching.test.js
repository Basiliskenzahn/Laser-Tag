// Matching rules once signatures carry a person re-identification embedding (public/reid.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageSignatures, matchGallery } from '../public/identify.js';

// A random unit vector; random high-dimensional vectors are nearly orthogonal to each other.
function unit(n, seed) {
  let state = seed >>> 0 || 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) || 1e-12;
  const v = Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

let nextSeed = 100;

// A unit vector at a chosen cosine similarity to `base`, off in its own random direction (so two
// such vectors aren't accidentally similar to each other).
function similarTo(base, cosine) {
  const other = unit(base.length, nextSeed++);
  const dot = other.reduce((s, v, i) => s + v * base[i], 0);
  const orth = other.map((v, i) => v - dot * base[i]);
  const norm = Math.hypot(...orth);
  return base.map((v, i) => cosine * v + Math.sqrt(1 - cosine ** 2) * (orth[i] / norm));
}

// Colour parts that look like a strong match, so only the re-identification score can say no.
const colours = { hist: unit(64, 1), lower: unit(64, 2), grid: unit(192, 3), shape: [2.5, 0.5], embed: unit(256, 4) };
const rexReid = unit(512, 10);
const kaiReid = unit(512, 20);
const players = [
  { id: 'rex', name: 'Rex', gallery: [{ ...colours, reid: rexReid }, { ...colours, reid: similarTo(rexReid, 0.95) }] },
  { id: 'kai', name: 'Kai', gallery: [{ ...colours, reid: kaiReid }] },
];
const person = (reid) => ({ ...colours, reid });

test('the re-identification score decides when both sides have one', () => {
  const m = matchGallery(person(similarTo(rexReid, 0.85)), players, null, { closedSet: true });
  assert.equal(m.id, 'rex');
  assert.equal(m.hasReid, true);
  assert.equal(m.accepted, true);
  assert.ok(Math.abs(m.reid - 0.85) < 0.01);
});

test('a bystander is rejected even in closed-set mode, although the colours match', () => {
  const m = matchGallery(person(similarTo(rexReid, 0.55)), players, null, { closedSet: true, includeRejected: true });
  assert.equal(m.accepted, false);
  assert.equal(m.reason, 'score');
});

test('two players scoring almost the same is a tie, not a guess', () => {
  // Equally similar to Rex and Kai.
  const between = rexReid.map((v, i) => v + kaiReid[i]);
  const norm = Math.hypot(...between);
  const m = matchGallery(person(between.map((v) => v / norm)), players, null, { closedSet: true, includeRejected: true });
  if (m.score >= 0.72) assert.equal(m.reason, 'margin');
  else assert.equal(m.accepted, false);
});

test('galleries without re-identification keep the old colour behaviour', () => {
  const old = players.map((p) => ({ ...p, gallery: p.gallery.map(({ reid, ...rest }) => rest) }));
  const m = matchGallery(person(similarTo(rexReid, 0.55)), old, null, { closedSet: true });
  assert.equal(m.hasReid, false);
  assert.equal(m.accepted, true); // closed set still takes the best colour match
});

test('averaged scan samples keep a normalised re-identification embedding', () => {
  const avg = averageSignatures([person(rexReid), person(similarTo(rexReid, 0.9))]);
  assert.equal(avg.reid.length, 512);
  assert.ok(Math.abs(Math.hypot(...avg.reid) - 1) < 1e-9);
  assert.equal(averageSignatures([colours]).reid.length, 0);
});
