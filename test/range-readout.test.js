// The ?debug range readout (frontend/public/range-readout.js).
//
// The readout exists to separate two failure modes with opposite fixes - "the detector never
// found them" and "it found them and we refused them" - so the tests that matter are the ones
// that would fail if the line stopped distinguishing those. Everything else here is formatting.
//
// Expected values are LITERALS throughout, never derived from the thresholds being passed in. A
// test that computes its expectation from the same constant the code uses is `x >= x` and holds
// nothing down; the thresholds get their own tripwire at the bottom instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SHOWN_HEIGHTS, heightMark, rangeReadout, ratio, refusalTallies } from '../frontend/public/range-readout.js';

const FRAME_HEIGHT = 480;
const GATE = 0.18;
const FLOOR = 0.1;

// A live track at a given box height in frame pixels. `h` is what the whole readout turns on.
function track(h, extra = {}) {
  return { box: { x: 10, y: 10, w: Math.round(h / 2.4), h }, playerId: null, name: null, score: 0, reid: 0, hasReid: false, ...extra };
}

const diagnostics = (over = {}) => ({ ok: 0, tooFar: 0, farReid: 0, belowFloor: 0, partialBody: 0, edgeClipped: 0, ...over });

// ---- the distinction the whole line exists for ----

test('nobody detected reads differently from somebody detected and refused', () => {
  // 25 m, detector finds nothing: no box, so a lower gate would change nothing and only a
  // region-of-interest pass can help.
  const nothingFound = rangeReadout({
    boxes: [],
    tracks: [],
    videoHeight: FRAME_HEIGHT,
    diagnostics: diagnostics({ ok: 0 }),
    gate: GATE,
    floor: FLOOR,
  });
  // 25 m, detector finds them, the gate throws the box away: a lower gate is exactly the fix.
  const foundAndRefused = rangeReadout({
    boxes: [track(43).box],
    tracks: [track(43)],
    videoHeight: FRAME_HEIGHT,
    diagnostics: diagnostics({ belowFloor: 11 }),
    gate: GATE,
    floor: FLOOR,
  });

  assert.equal(nothingFound, 'Range 0box ≥.18/.10 · ok0');
  assert.equal(foundAndRefused, 'Range 1box h .09- ≥.18/.10 · ok0 low11');
  assert.notEqual(nothingFound, foundAndRefused);
});

test('a box height is marked by which side of which threshold it falls on', () => {
  // .40 above the gate, .14 in the far band, .06 under the floor - three distances, one line.
  const line = rangeReadout({
    boxes: [1, 2, 3].map(() => ({})),
    tracks: [track(192), track(67), track(29)],
    videoHeight: FRAME_HEIGHT,
    diagnostics: diagnostics({ ok: 8, tooFar: 3, belowFloor: 4 }),
    gate: GATE,
    floor: FLOOR,
  });
  assert.equal(line, 'Range 3box h .40 .14* .06- ≥.18/.10 · ok8 far3 low4');
});

test('heights are biggest first, so the likeliest target leads', () => {
  const line = rangeReadout({
    boxes: [{}, {}, {}],
    tracks: [track(29), track(192), track(67)],
    videoHeight: FRAME_HEIGHT,
    gate: GATE,
  });
  assert.equal(line, 'Range 3box h .40 .14* .06* ≥.18');
});

test('the box count comes from the detections, not the coasting tracks', () => {
  // A track coasts for up to half a second after the detector loses its box. If the count came
  // from the tracks, "the detector has stopped finding them" would be invisible - which is the
  // one thing the readout must never hide.
  const line = rangeReadout({
    boxes: [],
    tracks: [track(192)],
    videoHeight: FRAME_HEIGHT,
    gate: GATE,
  });
  assert.equal(line, 'Range 0box h .40 ≥.18');
});

test('box heights are used when there are no tracks, as on the scan screen', () => {
  // refreshScanPreview() fills state.boxes and never touches state.tracks, so the scan screen -
  // the one you are on while walking around measuring - has boxes only.
  const line = rangeReadout({
    boxes: [{ h: 87 }, { h: 43 }],
    tracks: [],
    videoHeight: FRAME_HEIGHT,
    gate: GATE,
    floor: FLOOR,
  });
  assert.equal(line, 'Range 2box h .18 .09- ≥.18/.10');
});

test('the mark is exact even where the printed ratio rounds to the gate', () => {
  // 86/480 is 0.1792: it prints as `.18` but it is under the gate, so it must still be marked.
  // Without the mark the line would read as if the box had passed, which is the one thing a
  // reader standing in a field cannot check for themselves.
  const line = rangeReadout({ boxes: [{ h: 86 }], videoHeight: FRAME_HEIGHT, gate: GATE, floor: FLOOR });
  assert.equal(line, 'Range 1box h .18* ≥.18/.10');
});

// ---- the score-degrades-with-distance pairing ----

test('a named track shows its re-identification score next to its box height', () => {
  const line = rangeReadout({
    boxes: [{}, {}],
    tracks: [
      track(197, { playerId: 'p1', name: 'Bob', reid: 0.78, hasReid: true }),
      track(67, { playerId: 'p2', name: 'Ann', reid: 0.61, hasReid: true }),
    ],
    videoHeight: FRAME_HEIGHT,
    diagnostics: diagnostics({ ok: 14 }),
    gate: GATE,
  });
  assert.equal(line, 'Range 2box h .41 .14* ≥.18 · ok14\nDist Bob .78@.41 Ann .61@.14');
});

test('a colour-only score is marked, because it is not on the re-identification scale', () => {
  const line = rangeReadout({
    boxes: [{}],
    tracks: [track(197, { playerId: 'p1', name: 'Bob', score: 0.52, hasReid: false })],
    videoHeight: FRAME_HEIGHT,
    gate: GATE,
  });
  assert.equal(line, 'Range 1box h .41 ≥.18\nDist Bob c.52@.41');
});

test('the local player is not listed as a named track', () => {
  const line = rangeReadout({
    boxes: [{}],
    tracks: [track(197, { playerId: 'me', name: 'Me', reid: 0.9, hasReid: true })],
    videoHeight: FRAME_HEIGHT,
    selfId: 'me',
    gate: GATE,
  });
  assert.equal(line, 'Range 1box h .41 ≥.18');
});

// ---- readability on a phone ----

test('only the refusal reasons that are firing are printed, and ok always is', () => {
  assert.equal(refusalTallies(diagnostics({ ok: 12, tooFar: 3 })), 'ok12 far3');
  assert.equal(refusalTallies(diagnostics()), 'ok0');
  assert.equal(
    refusalTallies({ ok: 1, tooFar: 2, farReid: 3, belowFloor: 4, partialBody: 5, edgeClipped: 6 }),
    'ok1 far2 reid3 low4 part5 clip6',
  );
});

test('at most four box heights are shown', () => {
  const line = rangeReadout({
    boxes: [{}, {}, {}, {}, {}, {}],
    tracks: [240, 220, 200, 180, 160, 140].map((h) => track(h)),
    videoHeight: FRAME_HEIGHT,
    gate: GATE,
  });
  assert.equal(line, 'Range 6box h .50 .46 .42 .38 ≥.18');
  assert.equal(MAX_SHOWN_HEIGHTS, 4);
});

// ---- absent and degenerate inputs ----

test('nothing is printed before the video has dimensions', () => {
  assert.equal(rangeReadout({ boxes: [{ h: 100 }], videoHeight: 0, gate: GATE }), '');
  assert.equal(rangeReadout({}), '');
});

test('an unavailable far floor is left out rather than invented', () => {
  // identify.js does not export the far floor yet. A readout that guessed one would be showing a
  // threshold nothing enforces, so sub-gate boxes fall back to the plain "refused" mark.
  const line = rangeReadout({ boxes: [{ h: 29 }], videoHeight: FRAME_HEIGHT, gate: GATE, floor: null });
  assert.equal(line, 'Range 1box h .06* ≥.18');
});

test('absent diagnostics drop the tallies instead of printing zeroes or NaN', () => {
  const line = rangeReadout({ boxes: [{ h: 197 }], videoHeight: FRAME_HEIGHT, diagnostics: null, gate: GATE });
  assert.equal(line, 'Range 1box h .41 ≥.18');
  // A partial object - an older identify.js, or one that grew a new reason - prints what it has.
  assert.equal(refusalTallies({ ok: 4 }), 'ok4');
  assert.equal(refusalTallies({ tooFar: 2 }), 'far2');
});

test('ratio formatting', () => {
  assert.equal(ratio(0.413), '.41');
  assert.equal(ratio(0.06), '.06');
  assert.equal(ratio(0), '0');
  assert.equal(ratio(1), '1.0');
  assert.equal(ratio(1.25), '1.3');
  assert.equal(ratio(NaN), '-');
  assert.equal(ratio(undefined), '-');
});

// ---- retune tripwire ----

test('the mark boundaries are inclusive at the gate and exclusive at the floor', () => {
  // Literals, not GATE/FLOOR: these are the boundary decisions, and deriving them from the inputs
  // would make the assertions vacuous.
  assert.equal(heightMark(0.18, 0.18, 0.1), '');
  assert.equal(heightMark(0.1799, 0.18, 0.1), '*');
  assert.equal(heightMark(0.1, 0.18, 0.1), '*');
  assert.equal(heightMark(0.0999, 0.18, 0.1), '-');
  assert.equal(heightMark(0.05, 0.18, null), '*');
});
