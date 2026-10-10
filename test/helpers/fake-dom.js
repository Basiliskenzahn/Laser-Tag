// Just enough browser for the scan screen to run under `node --test`.
//
// `frontend/public/env.js` reaches `document.getElementById` and `canvas.getContext('2d')` at
// module scope, so importing anything downstream of it needs a DOM before the import, not a
// mock afterwards. With this plus test/helpers/vendor-hooks.js, `screens/scan.js` imports and
// runs for real: the recording loop, the quality gates, identify.js's signature extraction and
// the selection pass all execute over pixels a test chose.
//
// The canvas model is the point of this file. Canvases here carry real RGBA pixels and
// `drawImage` really resamples them, because the scan's quality gates measure brightness,
// contrast and sharpness - a uniform colour would be rejected as `low-contrast` and nothing
// would ever enrol. And a canvas can be **discarded**, which is what iOS Safari does to canvas
// backing stores under memory pressure and the whole reason the enrolment bug existed: a
// discarded canvas is still a live object, `drawImage` from it paints *nothing*, and reading it
// back gives transparent black. Nothing in the app can tell that apart from a very dark photo
// unless it looks at alpha, which is what `frameLost` does.

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.lineWidth = 1;
    this.strokeStyle = '';
  }

  clearRect() {
    this.canvas.pixels.fill(0);
  }

  strokeRect() {}

  fillRect() {}

  // drawImage(src, dx, dy) | (src, dx, dy, dw, dh) | (src, sx, sy, sw, sh, dx, dy, dw, dh)
  drawImage(source, ...args) {
    const sw0 = sourceWidth(source);
    const sh0 = sourceHeight(source);
    let sx = 0;
    let sy = 0;
    let sw = sw0;
    let sh = sh0;
    let dx = 0;
    let dy = 0;
    let dw = this.canvas.width;
    let dh = this.canvas.height;
    if (args.length === 4) [dx, dy, dw, dh] = args;
    else if (args.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    else if (args.length === 2) [dx, dy] = args;

    // A discarded backing store paints nothing at all - the destination keeps whatever it had,
    // which for a freshly sized canvas is transparent black.
    if (source.discarded || !sw0 || !sh0) return;
    const src = source.pixels;
    if (!src) return;
    const dest = this.canvas.pixels;
    for (let y = 0; y < Math.round(dh); y++) {
      const ty = Math.round(dy) + y;
      if (ty < 0 || ty >= this.canvas.height) continue;
      const fy = Math.min(sh0 - 1, Math.max(0, Math.floor(sy + ((y + 0.5) * sh) / dh)));
      for (let x = 0; x < Math.round(dw); x++) {
        const tx = Math.round(dx) + x;
        if (tx < 0 || tx >= this.canvas.width) continue;
        const fx = Math.min(sw0 - 1, Math.max(0, Math.floor(sx + ((x + 0.5) * sw) / dw)));
        const from = (fy * sw0 + fx) * 4;
        const to = (ty * this.canvas.width + tx) * 4;
        dest[to] = src[from];
        dest[to + 1] = src[from + 1];
        dest[to + 2] = src[from + 2];
        dest[to + 3] = src[from + 3];
      }
    }
  }

  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    if (this.canvas.discarded) return { data, width: w, height: h };
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const from = ((y + row) * this.canvas.width + (x + col)) * 4;
        const to = (row * w + col) * 4;
        for (let i = 0; i < 4; i++) data[to + i] = this.canvas.pixels[from + i] ?? 0;
      }
    }
    return { data, width: w, height: h };
  }
}

function sourceWidth(source) {
  return source.videoWidth || source.width || 0;
}

function sourceHeight(source) {
  return source.videoHeight || source.height || 0;
}

export class FakeCanvas {
  constructor(width = 0, height = 0) {
    this.discarded = false;
    this._width = 0;
    this._height = 0;
    this.pixels = new Uint8ClampedArray(0);
    this.width = width;
    this.height = height;
    this.context = new FakeContext(this);
  }

  get width() {
    return this._width;
  }

  // Resizing clears the backing store, exactly as it does in a browser - which is how
  // releaseRecordedImage frees a frame rather than waiting for the collector.
  set width(value) {
    this._width = value;
    this.#resize();
  }

  get height() {
    return this._height;
  }

  set height(value) {
    this._height = value;
    this.#resize();
  }

  #resize() {
    this.pixels = new Uint8ClampedArray(Math.max(0, this._width * this._height * 4));
    this.discarded = false;
    this.peakBytes = Math.max(this.peakBytes ?? 0, this.pixels.length);
  }

  getContext() {
    return this.context;
  }

  toDataURL() {
    return 'data:image/jpeg;base64,fake';
  }

  /** What iOS does under memory pressure: the object survives, the pixels do not. */
  discard() {
    this.discarded = true;
    this.pixels.fill(0);
  }

  /** Bytes of backing store this canvas is holding, for the memory assertions. */
  get byteLength() {
    return this._width * this._height * 4;
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.innerHTMLValue = '';
    this.hidden = false;
    this.children = [];
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
    };
  }

  get innerHTML() {
    return this.innerHTMLValue;
  }

  set innerHTML(value) {
    this.innerHTMLValue = value;
    if (!value) this.children = [];
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  remove() {}

  addEventListener() {}

  removeEventListener() {}

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

/**
 * Installs the globals env.js and the screens need, and returns the handles a test drives:
 *
 *   video      - the camera, as a canvas whose pixels the test paints
 *   canvases   - every canvas the code under test created, in order
 *   element(id)- the stub behind $(id)
 *   store      - the localStorage backing map
 *   flush()    - run every queued animation frame and timer until nothing is left
 */
export function installFakeDom({ videoWidth = 640, videoHeight = 360 } = {}) {
  const elements = new Map();
  const canvases = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };

  const video = new FakeCanvas(videoWidth, videoHeight);
  video.videoWidth = videoWidth;
  video.videoHeight = videoHeight;
  video.hidden = false;

  const overlay = new FakeCanvas(videoWidth, videoHeight);
  elements.set('video', video);
  elements.set('overlay', overlay);

  const store = new Map();
  globalThis.location = { search: '' };
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  // scan.js reads the key list with Object.keys(localStorage), which on a real Storage enumerates
  // the stored keys rather than the methods. A Proxy is the only honest way to model that.
  globalThis.localStorage = new Proxy(globalThis.localStorage, {
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: undefined }),
  });

  globalThis.document = {
    // Any id the code asks for exists. The real page has them all, and a test that had to
    // enumerate every element the lobby renders would be a test about the markup.
    getElementById: element,
    createElement: (tag) => {
      if (tag === 'canvas') {
        const canvas = new FakeCanvas();
        canvases.push(canvas);
        return canvas;
      }
      return new FakeElement(tag);
    },
    body: new FakeElement('body'),
    addEventListener() {},
    hidden: false,
  };

  // Frames and timers resolve synchronously-ish, on the microtask queue, so a 12 s recording and
  // a 3 s countdown take microseconds. `performance.now()` is driven by the same clock, so the
  // loops still see time pass and still terminate.
  let now = 1000;
  const frames = [];
  const timers = [];
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = (callback, ms = 0) => {
    timers.push({ callback, at: now + ms });
    return timers.length;
  };
  globalThis.clearTimeout = () => {};
  globalThis.performance = {
    now: () => now,
  };

  // One pass of the queues: every frame callback, then every timer, advancing the clock to the
  // timer's deadline. Called in a loop by flush().
  const step = () => {
    const dueFrames = frames.splice(0, frames.length);
    now += 16;
    for (const callback of dueFrames) callback(now);
    if (!dueFrames.length && timers.length) {
      const next = timers.splice(0, 1)[0];
      now = Math.max(now, next.at);
      next.callback();
      return true;
    }
    return dueFrames.length > 0 || timers.length > 0;
  };

  const flush = async (maxSteps = 200_000) => {
    for (let i = 0; i < maxSteps; i++) {
      await Promise.resolve();
      if (!frames.length && !timers.length) {
        // Let any pending promise chain settle and queue more work before giving up.
        await new Promise((resolve) => process.nextTick(resolve));
        if (!frames.length && !timers.length) return;
      }
      step();
    }
    throw new Error('flush() did not settle');
  };

  // At most `steps` turns of the queues, without caring whether anything is left - for stopping
  // part-way through a scan, which is what cancelling is.
  const pump = async (steps) => {
    for (let i = 0; i < steps; i++) {
      await Promise.resolve();
      await new Promise((resolve) => process.nextTick(resolve));
      step();
    }
  };

  // Tests wrap requestAnimationFrame to drive the camera or to take frames away, and a wrapper
  // left behind would silently rig every test after it (which is how an early version of
  // scan-enrolment.test.js had four tests passing for the wrong reason).
  const pristineFrameHook = globalThis.requestAnimationFrame;
  const resetFrameHook = () => {
    globalThis.requestAnimationFrame = pristineFrameHook;
  };

  return {
    video,
    overlay,
    canvases,
    element,
    store,
    flush,
    pump,
    resetFrameHook,
    advance: (ms) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

/**
 * A synthetic person in the middle of the frame: a textured body on a textured background, so the
 * brightness, contrast and sharpness gates all pass on real arithmetic rather than by being
 * stubbed out. `hue` shifts the body colour, which is what makes two frames look like different
 * angles (or two scans look like different people).
 */
export function paintPerson(canvas, { hue = 0, bright = 1 } = {}) {
  const { width: w, height: h, pixels } = canvas;
  const boxX = Math.round(w * 0.35);
  const boxW = Math.round(w * 0.3);
  const boxY = Math.round(h * 0.1);
  const boxH = Math.round(h * 0.8);
  const clamp = (value) => Math.max(0, Math.min(255, value * bright));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inBody = x >= boxX && x < boxX + boxW && y >= boxY && y < boxY + boxH;
      // Deterministic per-pixel noise. Any downsample of it still has variance, which is what
      // the contrast and sharpness gates measure - a flat or regularly striped body can alias to
      // a constant and get thrown out as `low-contrast`, which would make the gates the thing
      // under test rather than the scan.
      const n = Math.sin((x * 12.9898 + y * 78.233) * (1 + hue)) * 43_758.545;
      const noise = (n - Math.floor(n)) * 70 - 35;
      if (inBody) {
        pixels[i] = clamp(100 + hue * 70 + noise);
        pixels[i + 1] = clamp(150 - hue * 40 + noise);
        pixels[i + 2] = clamp(190 - hue * 20 - noise);
      } else {
        pixels[i] = clamp(40 + noise);
        pixels[i + 1] = clamp(60 - noise);
        pixels[i + 2] = clamp(80 + noise);
      }
      pixels[i + 3] = 255;
    }
  }
  return { x: boxX, y: boxY, w: boxW, h: boxH, score: 0.9 };
}
