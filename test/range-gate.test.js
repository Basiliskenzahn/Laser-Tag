// The live range gate (frontend/public/identify.js).
//
// MIN_MATCH_HEIGHT_RATIO is the targeting range: a box shorter than that fraction of the frame is
// refused a signature outright (`usable: false`), on every signal, so it is never identified and
// never costs a re-identification inference. These tests drive the real `extractSignature` through
// the resampling canvas stub, because the gate is read off the pixel geometry of a frame.

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
  MIN_SHAPE_SCORE,
  EVIDENCE_MIN_PART,
  EVIDENCE_MIN_SCORE,
} = await import('../frontend/public/identify.js');

// 720p landscape, the frame the gate's "about 20 m" was worked out for.
const VIDEO = { width: 1280, height: 720 };
const PAINT = bands({ head: [196, 158, 130], shirt: [210, 60, 55], accent: [240, 196, 70], trousers: [40, 50, 120] });

// Height ratios are written out rather than computed from the constants: a test that derives its
// own expectation from the number it is guarding asserts x >= x.
const NEAR = { x: 100, y: 100, w: 120, h: 300, score: 0.9 }; // 0.417 of frame height
const FAR = { x: 400, y: 300, w: 26, h: 50, score: 0.9 }; // 0.069 - just inside the range
const TOO_FAR = { x: 500, y: 300, w: 24, h: 43, score: 0.9 }; // 0.060 - just past it
const PARTIAL_BODY = { x: 600, y: 200, w: 300, h: 150, score: 0.9 }; // aspect 0.5
const EDGE_CLIPPED = { x: 0, y: 200, w: 80, h: 200, score: 0.9 }; // touching the left edge

const person = (box) => ({ box, paint: PAINT });
const sceneFor = (box) => frame([person(box)], VIDEO);

function unit(n, seed) {
  let state = seed >>> 0 || 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) || 1e-12;
  const v = Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

const REX_REID = unit(512, 10);

// Rex, enrolled up close, with his re-identification embedding.
function rexGallery() {
  const entry = averageSignatures([extractSignature(sceneFor(NEAR), NEAR)]);
  entry.reid = REX_REID;
  return [{ id: 'rex', name: 'Rex', gallery: [entry] }];
}

function live(box, reid = null) {
  const signature = extractSignature(sceneFor(box), box);
  if (reid) signature.reid = reid;
  return signature;
}

test('`usable` means "passed boxQuality", and `range` says which gate refused it', () => {
  const expected = [
    [NEAR, 'ok', true],
    [FAR, 'ok', true],
    [TOO_FAR, 'too-far', false],
    [PARTIAL_BODY, 'partial-body', false],
    [EDGE_CLIPPED, 'edge-clipped', false],
  ];
  for (const [box, range, usable] of expected) {
    const signature = live(box);
    assert.equal(signature.range, range, `${box.w}x${box.h} should be ${range}`);
    assert.equal(signature.usable, usable, `${box.w}x${box.h} should report usable: ${usable}`);
  }
});

test('a box inside the range is identified, and one past it is not at any score', () => {
  const players = rexGallery();
  const far = matchGallery(live(FAR, REX_REID), players, null, { includeRejected: true });
  assert.ok(far, 'a box just inside the range must be ranked');
  assert.equal(far.id, 'rex');
  assert.equal(far.accepted, true);

  assert.equal(matchGallery(live(TOO_FAR, REX_REID), players, null, { includeRejected: true }), null);
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

test('a box past the range costs no re-identification inference', () => {
  // A refused box used to pay a full 128x256 OSNet inference on every check and have the result
  // thrown away at the usable gate.
  const past = driveOnce([TOO_FAR], () => REX_REID);
  assert.equal(past.reid.requests.length, 0, 'no inference may be spent past the range');
  assert.equal(past.tracks[0].playerId, null, 'and it is not identified');

  assert.equal(driveOnce([FAR], () => REX_REID).reid.requests.length, 1, 'a box in range still embeds');
});

test('the range diagnostics count each live check once', () => {
  resetRangeDiagnostics();
  assert.deepStrictEqual(rangeDiagnostics(), { ok: 0, tooFar: 0, partialBody: 0, edgeClipped: 0 });

  const boxes = [NEAR, TOO_FAR, PARTIAL_BODY, EDGE_CLIPPED];
  const { tracks } = driveOnce(boxes, () => REX_REID);
  assert.equal(tracks.length, boxes.length, 'each box should get its own track');
  assert.deepStrictEqual(rangeDiagnostics(), { ok: 1, tooFar: 1, partialBody: 1, edgeClipped: 1 });

  // ...and the counters really are counts, not flags.
  driveOnce([NEAR], () => REX_REID);
  assert.equal(rangeDiagnostics().ok, 2);

  // The accessor hands out a copy: a caller cannot zero the game's counters by writing to it.
  const snapshot = rangeDiagnostics();
  snapshot.ok = 999;
  assert.equal(rangeDiagnostics().ok, 2);

  resetRangeDiagnostics();
  assert.equal(rangeDiagnostics().ok, 0);
});

test('a box refused for want of an embedding is still counted', () => {
  // The tracker gives up before matchGallery when re-identification has nothing for the track yet.
  // It must not fall out of the readout.
  resetRangeDiagnostics();
  driveOnce([TOO_FAR], () => null);
  assert.deepStrictEqual(rangeDiagnostics(), { ok: 0, tooFar: 1, partialBody: 0, edgeClipped: 0 });
  resetRangeDiagnostics();
});

test('the exported thresholds are the values they were tuned at', () => {
  // tools/shape-evaluation.mjs reads these instead of mirroring them by value. Asserted as
  // literals so a deliberate retune has to come past this line and update the docs.
  assert.equal(MIN_SHAPE_SCORE, 0.36);
  assert.equal(EVIDENCE_MIN_PART, 0.24);
  assert.equal(EVIDENCE_MIN_SCORE, 0.42);
  assert.equal(MIN_MATCH_HEIGHT_RATIO, 0.065);
});
