// "Is something moving where we haven't found anybody?" - movement as a detection signal, taken
// from the camera image alone.
//
// This answers *where to look*, never *who someone is*. It produces one boolean per detection
// cycle, which screens/game.js folds into detectTier() as one more reason to run the fast cadence
// and to relax the pose landmarker. It never produces a box, never reaches the tracker, and
// cannot name, target or shoot anybody - identify.js owns naming and nothing here touches it.
//
// Why movement at all. EfficientDet-Lite0 sees a fixed 320x320 tensor, so a person at 15 m is a
// few dozen pixels in the frame and gets missed outright. Those same few pixels still *change*
// from frame to frame when the person moves, and changing is far cheaper to notice than
// recognising: a pixel that differs from the one before it is one subtraction. That is what makes
// this scale-invariant in the way that matters here, and it is the whole reason a tiny downscale
// is enough.
//
//   sampleFrameMotion(source, now, { boxes, trackBoxes })  one cycle's look
//   frameMotionHint(now)                                   is a hint holding right now?
//   resetFrameMotion()                                     forget everything (tests, and a rejoin)
//
// ---- cost, which is the whole problem ----
//
// Detection already runs at up to 20 fps under a 70% duty cap, and the field complaints were a low
// tracking rate *and* a laggy FIRE button, so anything added here has to be nearly free.
//
// The arithmetic is free, and measured: 128x72 is 9216 pixels, two integer passes, 0.083 ms per
// cycle. The readback is neither free nor arithmetic - getImageData is a GPU->CPU transfer, and
// reid.js's 128x256 one (32768 pixels, 3.5x this) is the measured ~0.30 ms of JS plus an
// unmodelled transfer on top. So the readback is rationed two ways rather than trusted to be
// small:
//
//   * one per detection cycle at most, never per track and never per box; and
//   * skipped outright whenever the answer could not change anything - while a hint is already
//     holding, and while the loop is already in its 'lost' tier, which is the busiest state the
//     game has and the one where the thread is most contended. Movement cannot escalate a cadence
//     that is already maximal, so in that state this module costs exactly zero.
//
// The canvas is created with `willReadFrequently`, as reid.js's is, which asks the browser to keep
// the backing store in CPU memory and turns the transfer into a copy.
//
// ---- camera shake, which is what makes naive differencing useless ----
//
// A hand-held phone pans constantly, and a pan moves every textured pixel in the frame, so a raw
// diff lights up everywhere and means nothing. The deleted accelerometer code masked this with a
// PANNING_DEG_PER_S gyroscope gate; there is no gyroscope here by design, so it is solved from the
// image instead, with two guards that are nearly free because both ride on the pass that was
// happening anyway:
//
//   global-motion reject   If more than GLOBAL_MAX_CELLS of the grid is moving, this was the
//                          camera moving, not something in front of it. Learn nothing: no hint,
//                          and the frame is still stored so the next cycle has something recent to
//                          diff against. A frame you cannot register is a frame you cannot learn
//                          from, and the safe answer there is silence.
//   exposure normalisation Auto-exposure steps the whole frame's brightness at once, which a raw
//                          diff also reads as total motion. Each pixel is compared against its
//                          own frame's mean, so a uniform brightness shift cancels and only
//                          genuine local change survives. Measured: a +25 grey level step over
//                          the whole frame lights zero cells.
//
// A stale previous frame is a third way to get a meaningless diff - after a skipped cycle the two
// frames can be a second apart, and everything will have moved. MAX_GAP_MS throws that away
// explicitly rather than leaning on the global gate to catch it.
//
// What this costs honestly, and it is worth stating plainly: a camera that is drifting by more
// than about two source pixels per cycle is rejected, so on a visibly shaky hold this module says
// nothing at all and the game behaves exactly as it did before it existed. Registering the frames
// instead of rejecting them was tried and does not work at this scale: two source pixels of drift
// is a *fifth of a pixel* once the frame is 128 wide, so there is no integer shift to find, and a
// profile-correlation alignment (cheap, 0.038 ms) measured a shift of zero and improved nothing on
// any drift case. Sub-pixel registration would cost interpolation and still leave a
// gradient-dependent residual.
//
// What makes that limitation survivable is the refractory below. Movement only gets to speak once
// per SUPPRESS_MS, so this needs *one* steady pair of frames in that window rather than a steady
// hand throughout - and it keeps trying every cycle until it gets one. The quiet moments between
// a player's aiming corrections are enough.
//
// ---- degrading to nothing ----
//
// Every failure path returns no hint, which leaves detectTier() exactly as it was before this
// module existed: a readback that throws, a source with no dimensions, a canvas iOS discarded
// under memory pressure (all-transparent pixels), a first cycle with nothing to diff against. A
// throwing readback also disables the module permanently rather than being retried every cycle,
// since the thing that makes it throw does not heal.

import { regionCovered } from './detector.js';

// The downscale. Width is fixed and the height follows the camera's aspect, so this is 128x72 on
// the 16:9 stream the game asks for.
//
// 128 is measured, not guessed, and the obvious smaller sizes do not work. Area-averaged down from
// 720p, with a walking person's one-cycle displacement, the peak changed-pixel count in a single
// cell for a person 8% of the frame's height is 13 at 128 wide, 2-6 at 96 wide depending on the
// threshold, and **0 at 64 wide at every threshold tried** - at 64 a distant person does not
// survive the downscale at all, which is the one case this whole module exists for. The table is
// in docs/client/detection.md. The arithmetic is 0.083 ms either way, so there was nothing to buy
// by going smaller.
const FRAME_WIDTH = 128;
const MIN_FRAME_HEIGHT = 16;

// The cell grid the changed pixels are counted into. Cells exist to keep a person's few changed
// pixels *together*: the same pixels scattered across the frame are noise, and in one cell they
// are something. 12x9 is 108 cells of about 10x8 pixels at 128x72.
const GRID_COLS = 12;
const GRID_ROWS = 9;
const GRID_CELLS = GRID_COLS * GRID_ROWS;

// Greyscale levels of change, after the exposure normalisation above, that count a pixel as
// changed. Also measured, and it is a two-sided choice rather than a noise floor: the downscale
// averages ~100 source pixels into each of these, so sensor noise here is a fraction of a grey
// level and almost any threshold clears it. What sets this is camera shake at one end and a
// distant person at the other. At 8 a one-pixel hand tremor already lights six cells; at 18 a
// person 6% of the frame's height stops registering. 12 is the measured middle, where a 2-pixel
// tremor lights none and a 6% person lights one.
const PIXEL_DELTA = 12;

// Changed pixels in one cell before that cell is "moving". An absolute count rather than a share,
// because the case this is for is a *small* mover: a distant person covers a fraction of one cell,
// and a share of the cell would ask them to be large, which is exactly the assumption that makes
// the object detector miss them in the first place.
const CELL_MIN_PIXELS = 6;

// More moving cells than this and the camera moved, not something in front of it.
//
// A count of *cells* rather than a share of changed pixels, because that is where the measured
// separation is. A person moving lights 1 cell at 6% of the frame's height, 4 at 18%, 6 at 30%
// (close enough to be filling the frame); the camera moving lights 40 at a 1% forward zoom, 48 at
// a 4-pixel pan, and all 108 at anything faster. One person against a moving camera is 6 versus
// 40, where changed-pixel share puts the same two cases at 0.9% versus 6.2% - the same ratio, but
// cell counts say plainly *why*: movement in front of the camera is local, and movement of the
// camera is everywhere. 24 sits with a 4x margin over the largest mover and a 1.7x margin under
// the gentlest camera motion.
const GLOBAL_MAX_CELLS = 24;

// Two frames further apart than this are not a difference, they are two different pictures.
const MAX_GAP_MS = 400;

// How long one hint keeps the fast tier and the relaxed pose interval. Longer than the relaxed
// pose interval (200 ms in screens/game.js) on purpose, so a hint is always worth at least one
// pose pass - the pass that actually finds a person the object detector missed.
const HINT_HOLD_MS = 300;

// ...and how long until movement may ask again, counted from when the hold started. This is the
// cost bound, and it is the reason a moving curtain cannot pin the phone at the fast tier: the
// hold plus the refractory is a fixed cycle, so movement can hold the fast tier for at most
// HINT_HOLD_MS / SUPPRESS_MS of the time whatever is moving in frame and however much of it.
// Deliberately global rather than per cell: two moving regions taking turns would defeat a
// per-cell refractory, and nothing is lost, because the pose pass a hint buys looks at the whole
// frame anyway. Pointing is not what the hint is for.
const SUPPRESS_MS = 1800;

let canvas = null;
let context = null;
let width = 0;
let height = 0;
let colOf = null;
let rowOf = null;
let cells = null;

let previous = null;
let previousMean = 0;
let previousAt = 0;
let hintUntil = 0;
let suppressedUntil = 0;
let disabled = false;

export function resetFrameMotion() {
  previous = null;
  previousMean = 0;
  previousAt = 0;
  hintUntil = 0;
  suppressedUntil = 0;
  disabled = false;
}

// Is a movement hint holding right now? This is the module's whole output, and screens/game.js's
// detectTier() is its only caller.
export function frameMotionHint(now) {
  return now < hintUntil;
}

// Would sampling this cycle be able to change anything? No while a hint is already holding (the
// hold is running and a second hint cannot extend it past the refractory) and no while the hint is
// in its refractory. The caller adds the one state this module cannot see for itself - the 'lost'
// tier, which is already as escalated as the loop goes.
export function frameMotionWorthSampling(now) {
  return !disabled && now >= hintUntil && now >= suppressedUntil;
}

function resize(w, h) {
  if (width === w && height === h) return;
  width = w;
  height = h;
  canvas.width = w;
  canvas.height = h;
  previous = null;
  // Which cell each column and each row belongs to, so the counting pass is two array lookups per
  // pixel instead of two divisions, and so any frame size maps onto the grid exactly.
  colOf = new Uint8Array(w);
  for (let x = 0; x < w; x++) colOf[x] = Math.min(GRID_COLS - 1, Math.floor((x * GRID_COLS) / w));
  rowOf = new Uint8Array(h);
  for (let y = 0; y < h; y++) rowOf[y] = Math.min(GRID_ROWS - 1, Math.floor((y * GRID_ROWS) / h));
  cells = new Int32Array(GRID_COLS * GRID_ROWS);
}

function sourceWidth(source) {
  return source.videoWidth || source.width || 0;
}

function sourceHeight(source) {
  return source.videoHeight || source.height || 0;
}

// The one readback. Returns the greyscale frame and its mean, or null if the frame is unusable -
// which includes the canvas iOS discarded out from under us, whose pixels read back as
// transparent black and are indistinguishable from a very dark photo unless you look at alpha.
function grab(source) {
  const sw = sourceWidth(source);
  const sh = sourceHeight(source);
  if (!sw || !sh) return null;
  const w = Math.min(FRAME_WIDTH, sw);
  const h = Math.max(MIN_FRAME_HEIGHT, Math.round((w * sh) / sw));
  canvas ??= document.createElement('canvas');
  context ??= canvas.getContext('2d', { willReadFrequently: true });
  resize(w, h);

  let data;
  try {
    context.drawImage(source, 0, 0, w, h);
    data = context.getImageData(0, 0, w, h).data;
  } catch (err) {
    // Whatever makes a readback throw here (a tainted canvas, a context lost for good) does not
    // heal, so stop asking rather than paying for the throw every cycle.
    disabled = true;
    console.warn('frame differencing unavailable', err);
    return null;
  }

  const pixels = w * h;
  const frame = new Uint8Array(pixels);
  let sum = 0;
  let alpha = 0;
  for (let i = 0; i < pixels; i++) {
    const p = i * 4;
    // Integer luma. The exact weights do not matter: both frames go through the same ones and only
    // their difference is read.
    const grey = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
    frame[i] = grey;
    sum += grey;
    alpha += data[p + 3];
  }
  if (!alpha) return null;
  return { frame, mean: sum / pixels };
}

function store(frame, mean, now) {
  previous = frame;
  previousMean = mean;
  previousAt = now;
}

/**
 * One cycle's look at whether anything is moving that we have not found.
 *
 * `source` is whatever the object detector was handed this cycle - the video, or the downscaled
 * inference canvas - so the movement is measured on the same picture the detector saw. `boxes` are
 * that detector's most recent boxes and `trackBoxes` the live tracks' projected ones, both in the
 * same coordinates; a cell either of them covers is movement we have already accounted for.
 *
 * Returns a small record of what happened, and - the part that matters - sets the hint that
 * frameMotionHint() reports. Every refusal path returns `hint: false`.
 */
export function sampleFrameMotion(source, now, { boxes = [], trackBoxes = [] } = {}) {
  if (disabled) return { sampled: false, reason: 'disabled', hint: false };

  const grabbed = grab(source);
  if (!grabbed) return { sampled: false, reason: disabled ? 'disabled' : 'unusable-frame', hint: false };
  const { frame, mean } = grabbed;

  if (!previous || previous.length !== frame.length) {
    store(frame, mean, now);
    return { sampled: true, reason: 'first-frame', hint: false };
  }
  if (now - previousAt > MAX_GAP_MS) {
    store(frame, mean, now);
    return { sampled: true, reason: 'stale-previous', hint: false };
  }

  // Compare each pixel against its own frame's mean, so an auto-exposure step cancels instead of
  // reading as the whole frame moving.
  const exposure = mean - previousMean;
  cells.fill(0);
  for (let y = 0; y < height; y++) {
    const cellRow = rowOf[y] * GRID_COLS;
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const i = base + x;
      const delta = frame[i] - previous[i] - exposure;
      if (delta > PIXEL_DELTA || delta < -PIXEL_DELTA) cells[cellRow + colOf[x]]++;
    }
  }
  store(frame, mean, now);

  let moving = 0;
  for (let i = 0; i < GRID_CELLS; i++) if (cells[i] >= CELL_MIN_PIXELS) moving++;
  if (moving > GLOBAL_MAX_CELLS) {
    // The camera moved. Nothing in this frame can be attributed to anything in front of it, so
    // this cycle learns nothing - the frame is kept, the verdict is thrown away.
    return { sampled: true, reason: 'global-motion', moving, hint: false };
  }

  const sw = sourceWidth(source);
  const sh = sourceHeight(source);
  let uncovered = 0;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (cells[row * GRID_COLS + col] < CELL_MIN_PIXELS) continue;
      const region = {
        x: (col * sw) / GRID_COLS,
        y: (row * sh) / GRID_ROWS,
        w: sw / GRID_COLS,
        h: sh / GRID_ROWS,
      };
      if (!regionCovered(region, boxes) && !regionCovered(region, trackBoxes)) uncovered++;
    }
  }

  if (!uncovered) return { sampled: true, reason: 'nothing-uncovered', moving, uncovered, hint: false };
  if (now < suppressedUntil) return { sampled: true, reason: 'suppressed', moving, uncovered, hint: false };

  hintUntil = now + HINT_HOLD_MS;
  suppressedUntil = now + SUPPRESS_MS;
  return { sampled: true, reason: 'hint', moving, uncovered, hint: true };
}
