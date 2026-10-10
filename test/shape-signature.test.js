// The `shape` feature of the colour signature (frontend/public/identify.js).
//
// `shape` is the one feature compared with a scale-*sensitive* similarity - a log ratio of box
// aspects - while every other feature is compared with cosine, which normalises internally. It was
// therefore the one feature for which L2-normalising a gallery entry was not free, and for a long
// time `averageSignatures()` normalised it anyway: a live aspect of ~2.25 was compared against a
// gallery entry of 0.600, and the correct person scored 0. See docs/shape-feature-bug.md.
//
// These tests drive the real extractSignature -> averageSignatures -> matchGallery path, because
// the defect lived in the *seam* between extraction and averaging. The older tests hand-build
// galleries with raw `shape` on both sides and so passed throughout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// extractSignature reads pixels back through a canvas. Rather than skip it - which is what hid the
// bug - stand in a canvas that resamples a synthetic frame, so the signatures under test are the
// ones production builds. Installed before identify.js is ever called, not before it is imported:
// the module only touches `document` lazily, inside readPixels.
installCanvasStub();

const { averageSignatures, extractSignature, matchGallery } = await import('../frontend/public/identify.js');

const BACKGROUND = [38, 40, 44];

// A frame containing `people`, each a flat shirt colour over a flat trouser colour. `pixel` is in
// source-frame coordinates; the canvas stub below resamples it exactly the way drawImage would.
function frame(people, { width = 640, height = 480 } = {}) {
  return {
    videoWidth: width,
    videoHeight: height,
    pixel(x, y) {
      for (const { box, shirt, trousers } of people) {
        if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) {
          return (y - box.y) / box.h < 0.52 ? shirt : trousers;
        }
      }
      return BACKGROUND;
    },
  };
}

function installCanvasStub() {
  let drawn = null;
  const ctx = {
    drawImage(source, sx, sy, sw, sh, _dx, _dy, dw, dh) {
      drawn = { source, sx, sy, sw, sh, dw, dh };
    },
    getImageData(_x, _y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      if (!drawn) return { data };
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const x = drawn.sx + ((i + 0.5) / drawn.dw) * drawn.sw;
          const y = drawn.sy + ((j + 0.5) / drawn.dh) * drawn.sh;
          const [r, g, b] = drawn.source.pixel(x, y);
          const at = (j * w + i) * 4;
          data[at] = r;
          data[at + 1] = g;
          data[at + 2] = b;
          data[at + 3] = 255;
        }
      }
      return { data };
    },
  };
  globalThis.document ??= { createElement: () => ({ getContext: () => ctx }) };
}

// `box` nudged by a pixel or two, the way consecutive detector boxes of a standing person are.
function jitter(box, k) {
  const wobble = [0, 1, -1, 2, -2, 1][k % 6];
  return { x: box.x + wobble, y: box.y - wobble, w: box.w + wobble, h: box.h - wobble, score: 0.9 };
}

// One enrolled gallery entry: several samples of the same person, averaged the way scan.js does.
function enrol(source, box, count = 6) {
  return averageSignatures(Array.from({ length: count }, (_, k) => extractSignature(source, jitter(box, k))));
}

function player(id, name, gallery) {
  return { id, name, gallery: Array.isArray(gallery) ? gallery : [gallery] };
}

// matchGallery's decision for `signature`, rejections included so the part scores are always
// visible. Open set, so the gates actually apply.
function match(signature, players) {
  return matchGallery(signature, players, null, { includeRejected: true });
}

const REX = { box: { x: 260, y: 140, w: 80, h: 180, score: 0.9 }, shirt: [210, 60, 55], trousers: [40, 50, 120] };
const ROUNDED = (v) => Math.round(v * 1000) / 1000;

test('a signature scores ~1 for shape against a gallery entry built from itself', () => {
  const source = frame([REX]);
  const gallery = enrol(source, REX.box);
  const live = extractSignature(source, REX.box);

  const m = match(live, [player('rex', 'Rex', gallery)]);
  assert.ok(m, 'the player should at least be ranked');
  assert.ok(m.shape > 0.99, `shape should be ~1 against its own gallery entry, got ${ROUNDED(m.shape)}`);
  assert.notEqual(m.reason, 'shape', 'the shape gate must not reject the correct person');
});

test('a gallery shape stays an aspect ratio rather than a unit vector', () => {
  // The direct guard against re-normalising. The second component of `shape` is the aspect times
  // the frame's own aspect ratio, so normalising collapsed every enrolled person to the same
  // 1/sqrt(1 + (vw/vh)^2) - 0.600 in a 4:3 frame - carrying no information about the person at all.
  const source = frame([REX]);
  const gallery = enrol(source, REX.box);
  const expected = REX.box.h / REX.box.w; // 2.25

  assert.ok(
    Math.abs(gallery.shape[0] - expected) < 0.05,
    `gallery shape[0] should be the mean aspect ~${expected}, got ${ROUNDED(gallery.shape[0])}`,
  );
  assert.ok(Math.abs(Math.hypot(...gallery.shape) - 1) > 0.5, 'a gallery shape must not be a unit vector');

  // ...and every other field is still normalised, because cosine does not care and uniform
  // magnitudes are cheaper to reason about in storage and in the join message.
  for (const field of ['hist', 'lower', 'grid']) {
    assert.ok(Math.abs(Math.hypot(...gallery[field]) - 1) < 1e-9, `${field} should still be a unit vector`);
  }
});

test('shape does not drift when the same person is further from the camera', () => {
  // Enrolled up close, matched at roughly half the box size: the aspect is the same person's, so
  // `shape` has to be the same too. This is the property the feature exists for - a guard that
  // works "without depending on distance from camera" (identify.js's header).
  const near = frame([REX]);
  const gallery = enrol(near, REX.box);

  const farBox = { x: 120, y: 250, w: 41, h: 92, score: 0.9 }; // same person, ~2.24 aspect, half the size
  const far = frame([{ ...REX, box: farBox }]);
  const live = extractSignature(far, farBox);

  const m = match(live, [player('rex', 'Rex', gallery)]);
  assert.ok(m.shape > 0.99, `shape should survive the distance change, got ${ROUNDED(m.shape)}`);

  // And it really is scale-independence, not luck: the near-range score is the same number.
  const nearScore = match(extractSignature(near, REX.box), [player('rex', 'Rex', gallery)]).shape;
  assert.ok(Math.abs(m.shape - nearScore) < 0.01, `far ${ROUNDED(m.shape)} vs near ${ROUNDED(nearScore)}`);
});

test('a clearly different body aspect still scores low', () => {
  // A fix that makes everything score 1 is not a fix. A squat, crouching or half-occluded box is
  // exactly what the guard is for.
  const source = frame([REX]);
  const gallery = enrol(source, REX.box);

  const squatBox = { x: 200, y: 300, w: 150, h: 150, score: 0.9 }; // aspect 1.0 against Rex's 2.25
  const squat = frame([{ ...REX, box: squatBox }]);
  const m = match(extractSignature(squat, squatBox), [player('rex', 'Rex', gallery)]);

  assert.ok(m.shape < 0.36, `a 1.0 aspect against a 2.25 gallery should fail the gate, got ${ROUNDED(m.shape)}`);

  // Something in between discriminates rather than saturating: a noticeably different build still
  // scores well under the self-match but above zero.
  const slimBox = { x: 200, y: 160, w: 58, h: 180, score: 0.9 }; // aspect ~3.1
  const slim = frame([{ ...REX, box: slimBox }]);
  const between = match(extractSignature(slim, slimBox), [player('rex', 'Rex', gallery)]).shape;
  assert.ok(between > 0 && between < 0.9, `an in-between build should score in between, got ${ROUNDED(between)}`);
});

test('the documented worked example no longer scores 0', () => {
  // An 80 x 180 box in a 640 x 480 frame: live `shape` [2.250, 3.000], which used to be matched
  // against a gallery entry of [0.600, 0.800] and score exactly 0 (docs/shape-feature-bug.md).
  const source = frame([REX]);
  const live = extractSignature(source, REX.box);
  assert.deepEqual(live.shape.map(ROUNDED), [2.25, 3], 'the live values the bug report measured');

  const gallery = averageSignatures([live]);
  assert.deepEqual(gallery.shape.map(ROUNDED), [2.25, 3], 'averaging one sample must not rescale it');

  const m = match(live, [player('rex', 'Rex', gallery)]);
  assert.ok(m.shape > 0.999, `the worked example should now score ~1, got ${ROUNDED(m.shape)}`);
});

// ---- The re-identification path must not notice any of this ----

function unit(n, seed) {
  let state = seed >>> 0 || 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) || 1e-12;
  const v = Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function l2(vec) {
  const norm = Math.hypot(...vec) || 1;
  return vec.map((v) => v / norm);
}

test('the re-identification path ignores shape entirely, so its score is unchanged', () => {
  const source = frame([REX]);
  const reid = unit(512, 11);
  const gallery = { ...enrol(source, REX.box), reid };
  const live = { ...extractSignature(source, REX.box), reid };

  const fixed = match(live, [player('rex', 'Rex', gallery)]);
  // The same gallery entry as an older build stored it: `shape` L2-normalised to [0.6, 0.8].
  const legacy = match(live, [player('rex', 'Rex', { ...gallery, shape: l2(gallery.shape) })]);
  // ...and `shape` replaced by something physically impossible, to show it is not merely close.
  const absurd = match(live, [player('rex', 'Rex', { ...gallery, shape: [0.004, 900] })]);

  assert.equal(fixed.hasReid, true);
  for (const other of [legacy, absurd]) {
    assert.equal(other.score, fixed.score, 'the re-identification score must not depend on shape');
    assert.equal(other.accepted, fixed.accepted);
    assert.equal(other.reason ?? null, fixed.reason ?? null);
  }
  assert.ok(Math.abs(fixed.score - 1) < 1e-9, 'a signature against its own embedding scores 1');
  // Only the debug-only part score moved.
  assert.ok(fixed.shape > 0.99 && legacy.shape === 0, `fixed ${ROUNDED(fixed.shape)}, legacy ${legacy.shape}`);
});

test('the MobileNet-embedding path does change, by exactly its shape weight', () => {
  // Honest bookkeeping: rejectionReason() skips the per-part floors only for `hasReid`, so the
  // embedder path (signal 2) carried the broken shape gate too, and its blend spends
  // EMBED_SHAPE_WEIGHT = 0.06 on `shape`. Correcting the feature therefore moves that path's score
  // by up to 0.06 for a correct match - upwards, and bounded. Nothing else about it changes.
  const source = frame([REX]);
  const embed = unit(256, 21);
  const gallery = { ...enrol(source, REX.box), embed };
  const live = { ...extractSignature(source, REX.box), embed };

  const fixed = match(live, [player('rex', 'Rex', gallery)]);
  const legacy = match(live, [player('rex', 'Rex', { ...gallery, shape: l2(gallery.shape) })]);

  assert.equal(fixed.hasReid, false);
  const delta = fixed.score - legacy.score;
  assert.ok(
    Math.abs(delta - 0.06 * (fixed.shape - legacy.shape)) < 1e-9,
    `the whole difference should be EMBED_SHAPE_WEIGHT * d(shape), got ${ROUNDED(delta)}`,
  );
  assert.ok(delta > 0 && delta <= 0.06 + 1e-9, `and it should be a bounded improvement, got ${ROUNDED(delta)}`);
  assert.equal(legacy.reason, 'shape', 'the old gate rejected the correct person on this path too');
  assert.notEqual(fixed.reason, 'shape');
});

test('a colour-only check can now count as evidence at all', () => {
  // EVIDENCE_MIN_PART (0.24) applies to every colour part, `shape` included, so with `shape` stuck
  // at 0 no colour-only check ever accumulated evidence. This is the real functional change; the
  // thresholds themselves are deliberately untouched.
  const source = frame([REX]);
  const gallery = enrol(source, REX.box);
  const live = extractSignature(source, REX.box);

  const fixed = match(live, [player('rex', 'Rex', gallery)]);
  const legacy = match(live, [player('rex', 'Rex', { ...gallery, shape: l2(gallery.shape) })]);

  const parts = (m) => [m.upper, m.lower, m.grid, m.shape];
  assert.ok(parts(fixed).every((p) => p >= 0.24), `all parts should clear the evidence floor: ${parts(fixed).map(ROUNDED)}`);
  assert.ok(legacy.shape < 0.24, 'which it could not do before');
});
