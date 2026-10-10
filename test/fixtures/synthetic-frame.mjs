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
export function frame(people, { width = 640, height = 480, background = BACKGROUND } = {}) {
  return {
    videoWidth: width,
    videoHeight: height,
    pixel(x, y) {
      for (const { box, paint } of people) {
        if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) {
          return paint((x - box.x) / box.w, (y - box.y) / box.h);
        }
      }
      return background;
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
