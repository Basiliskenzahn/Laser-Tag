// A fake video frame and a fake canvas, so `extractSignature()` can be exercised in Node.
//
// identify.js reads its colour features back through a 2D canvas (`readPixels`), which is why most
// of the existing tests drive the Tracker around extraction instead of through it - and why a
// defect in the seam between extraction and averaging went unnoticed. This stands in a canvas that
// resamples a synthetic frame exactly the way `drawImage` would, so the signatures under test are
// the ones production builds.
//
// Shared by test/shape-signature.test.js and tools/shape-evaluation.mjs, so the regression tests
// and the measurement harness cannot disagree about what a synthetic person looks like.

// Installs the stub on `globalThis.document`. Safe to call more than once, and only ever fills in
// a missing `document`, so it never shadows a real DOM. Call it before the first signature is
// extracted; identify.js only touches `document` lazily, so importing it first is fine.
export function installCanvasStub() {
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
  return globalThis.document;
}

export const BACKGROUND = [38, 40, 44];

// A frame holding `people`: `[{ box, paint(u, v) }]`, where u/v are fractions across and down that
// person's own box. First match wins, so earlier people stand in front of later ones.
//
// `sensorGrid` (off by default, so every existing caller is byte-for-byte unchanged) snaps reads
// to the pixel lattice - see sensorGrid() below for why that matters and what it still does not
// model.
export function frame(people, { width = 640, height = 480, background = BACKGROUND, sensorGrid = false } = {}) {
  const paintAt = (x, y) => {
    for (const { box, paint } of people) {
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) {
        return paint((x - box.x) / box.w, (y - box.y) / box.h);
      }
    }
    return background;
  };
  if (!sensorGrid) return { videoWidth: width, videoHeight: height, pixel: paintAt };

  // Without this, `paint` is an analytic function of position: it answers at infinite resolution,
  // so a box 20 px wide looks exactly as detailed as one 300 px wide. `extractSignature` reads a
  // box back through an 18x24 (and 6x8) canvas, so a distant box is *upsampled* into the feature
  // canvas, and this fixture had been quietly inventing the detail that upsampling cannot recover.
  // Worse, `noise` was being drawn fresh at every sampled point, so a small box got as many
  // independent noise samples as a large one and averaged them away just as well.
  //
  // Snapping each read to the integer pixel it came from, and remembering what that pixel came
  // out as, fixes both: a box only ever has as many distinct values as it has sensor pixels, and
  // its noise is stuck to them. What it still does NOT model: lens blur, motion blur, atmospheric
  // haze, JPEG/ISP artefacts, or the detector box getting sloppier at range. Nearest-neighbour
  // replication is also harsher in the high frequencies than a real bilinear upsample. So this is
  // a floor on how much detail a distant box loses, not an estimate of it.
  const cache = new Map();
  return {
    videoWidth: width,
    videoHeight: height,
    pixel(x, y) {
      const px = Math.floor(x);
      const py = Math.floor(y);
      const key = py * width + px;
      let value = cache.get(key);
      if (value === undefined) {
        value = paintAt(px + 0.5, py + 0.5);
        cache.set(key, value);
      }
      return value;
    },
  };
}

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

// A crude person: head, shirt with a vertical accent stripe, trousers. The stripe's position is
// what makes one enrolled angle differ from another in `grid` without changing `hist` much, which
// is the split the real feature set relies on. `gain` stands in for lighting, `noise(u, v)` for
// sensor noise and texture; both default to none.
export function bands({ head, shirt, accent, trousers, stripe = 0.5, gain = 1, noise = null }) {
  return (u, v) => {
    const base =
      v < 0.14 ? head : v < 0.55 ? (Math.abs(u - stripe) < 0.12 ? accent ?? shirt : shirt) : trousers;
    const jitter = noise ? noise(u, v) : 0;
    return base.map((channel) => clamp255(channel * gain + jitter));
  };
}
