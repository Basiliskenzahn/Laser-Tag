// Telling players apart, not just finding "a person".
//
// Plain person detection (detector.js) finds boxes; this module decides *who* is in each box.
//
// Four signals can answer that, and they are deliberately a fallback chain rather than a
// committee: the best signal the phone can actually run wins outright, and the weaker ones stay
// so that an older device, or a model that failed to load, still gets a game that mostly works.
// Strongest first:
//
//   1. Person re-identification (reid.js). OSNet, trained specifically to tell people apart
//      across cameras, angles and lighting. When both the live signature and a gallery sample
//      carry a `reid` vector, its cosine similarity *is* the score and the colour parts below
//      are ignored - blending them in measured worse than re-identification alone, so they are
//      computed only for debugging (see similarityParts). It also gates identification: while
//      re-identification is loaded but has no embedding for a track yet, that track stays
//      unnamed instead of falling back to colours, because colour-only matching is exactly what
//      used to label bystanders as players (see Tracker.update).
//   2. A generic MobileNet image embedding (`personEmbedding`/`embedRegion`, inline below; the
//      model comes from detector.js). It was not trained to tell people apart, but it beats raw
//      colour, so when it is present and re-identification is not it is *blended* with the
//      colour parts rather than replacing them (the EMBED_* weights).
//   3. The hand-built colour signature (inline below): upper- and lower-body colour histograms,
//      a coarse colour/shape grid, and box proportions. Canvas pixels only, no model, so it is
//      always available. Used on its own when neither model loaded (the HIST/LOWER/GRID/SHAPE
//      weights), and it is the weakest of the three by a wide margin.
//   4. Phone motion (motion/sensor.js + motion/matching.js). Orthogonal to appearance: it
//      correlates a tracked box's movement on screen with each player's own accelerometer. It
//      deliberately does *not* feed the score here. It is a confirm/veto layer on top, applied
//      by app.js (fuseMotion) to the identity a track already carries, so it can back up a weak
//      appearance match or veto a bystander who happens to dress like a player.
//
// So: signals 1-3 produce one per-sample score in matchGallery, 1 overriding 2 overriding 3; the
// Tracker then wants several agreeing samples over time, with hysteresis, before it puts a name
// on a track; and signal 4 is consulted per track by app.js after all of that.
//
// Several body-appearance features are extracted per sample:
//
//   hist  - colour/brightness histogram of the upper body. Clothing colour barely changes
//           with viewing angle, so this is the main angle-*invariant* signal.
//   lower - same descriptor for the lower body. This is a strong false-positive guard:
//           a similar shirt is not enough if trousers/skirt/background layout differ.
//   grid  - a coarse brightness/chroma grid over the whole body box. It's a rough shape+colour
//           fingerprint that DOES change with viewing angle, which is exactly why enrolment
//           takes one grid per angle (front/right/back/left) and matching takes whichever
//           enrolled angle looks closest to the current view.
//   shape - coarse box proportions, used only as a guard. It helps reject partial bodies and
//           people with very different pose/framing without depending on distance from camera.
//
//   embed - an optional learned image embedding. It is compacted before storage so larger
//           multi-angle scans still fit comfortably in the join message and local cache.
//   reid  - the re-identification embedding, computed in reid.js and attached by the caller
//           (Tracker.update during a game, app.js during enrolment), not extracted here.

// ---- Tuning constants ----
//
// Everything tunable lives here rather than next to its use, because these numbers interact:
// the accept thresholds are only meaningful against the weights that feed them, and the tracker
// then layers streaks and evidence on top of both. Changing one in isolation is how this gets
// worse. Values are unchanged from when they were tuned; the grouping is just so it is possible
// to see what a given number is fighting with.

// -- signature layout: how many bins/dimensions each feature spends --
const HUE_BINS = 12;
const SAT_BINS = 4;
const LUMA_BINS = 8;
const SAT_DETAIL_BINS = 8;
const GRID_W = 6;
const GRID_H = 8;
const GRID_FEATURES = 4;
const EMBED_DIMS = 256;
const EMBED_PRECISION = 10_000;

// -- box quality gates: when a detector box is worth extracting a signature from at all --
// Enrolment ("scan") is a cooperative, posed shot, so it can afford slightly looser limits than
// live matching, which has to cope with whatever the game gives it.
const MIN_SCAN_HEIGHT_RATIO = 0.18;
const MIN_MATCH_HEIGHT_RATIO = 0.18;
const MIN_BOX_WIDTH_RATIO = 0.035;
const MIN_SCAN_BOX_WIDTH_RATIO = 0.025;
const MIN_ASPECT = 0.58;
const MAX_ASPECT = 6.5;
const MIN_SCAN_ASPECT = 0.65;
const MAX_SCAN_ASPECT = 7.0;
const BOX_EDGE_PAD_RATIO = 0.01; // how close to the frame edge counts as touching it
const CLIPPED_OK_HEIGHT_RATIO = 0.55; // a box touching the edge is still usable once it's this tall
const CLIPPED_OK_SCAN_HEIGHT_RATIO = 0.42;

// -- colour/grid similarity weights: the score when neither model is available (signal 3) --
const HIST_WEIGHT = 0.42;
const LOWER_WEIGHT = 0.24;
const GRID_WEIGHT = 0.24;
const SHAPE_WEIGHT = 0.1;

// -- colour/grid + MobileNet weights: the blend used when an embedding is present (signal 2) --
const EMBED_HIST_WEIGHT = 0.3;
const EMBED_LOWER_WEIGHT = 0.18;
const EMBED_GRID_WEIGHT = 0.16;
const EMBED_SHAPE_WEIGHT = 0.06;
const EMBED_WEIGHT = 0.3;

// -- multi-angle gallery agreement: how much nearby enrolled angles get to back up the best one --
const GALLERY_TOP_MATCH_COUNT = 3;
const GALLERY_AGREEMENT_WINDOW = 0.1;
const GALLERY_AGREEMENT_WEIGHT = 0.25;
const GALLERY_SUPPORT_BONUS = 0.012;

// -- colour-signature accept thresholds: a win has to be good *and* unambiguous *and* all-round --
const MATCH_THRESHOLD = 0.54; // below this, call it unknown rather than guess
const MATCH_MARGIN = 0.06; // the winner must clear the runner-up by this much
const MIN_UPPER_SCORE = 0.5;
const MIN_LOWER_SCORE = 0.38;
const MIN_GRID_SCORE = 0.4;
const MIN_SHAPE_SCORE = 0.36;

// -- re-identification thresholds (cosine similarity of OSNet embeddings) --
// Chosen on Market-1501 in simulated games of 2-4 players, in the game's closed-set mode, per
// single check:
//   threshold 0.70 / 0.72 / 0.74 / 0.76 -> players recognised 87% / 83% / 77% / 71%,
//   bystanders accepted 10.8% / 7.6% / 4.9% / 3.1%, wrong player 0.3-0.5%.
// The tracker also needs agreeing checks before it names a track, so per person it's lower - see
// reid.js's header for the resulting *game-level* number (77% recognised at 5% bystander
// acceptance), which is lower than the 83%/7.6% above because it is not the same measurement.
// The margin halves wrong-player assignments.
const REID_MATCH_THRESHOLD = 0.72;
const REID_MATCH_MARGIN = 0.03;
const REID_EVIDENCE_MIN_SCORE = 0.62; // below this a check contributes no evidence at all
const REID_SOFT_LABEL_SCORE = 0.66; // good enough to be a candidate, not to be accepted outright
const REID_INITIAL_LOCK = 0.8; // name a brand new track on one check this strong

// -- tracker association and lifecycle: matching boxes to tracks frame to frame --
const ASSOCIATION_MATCH = 0.3; // minimum association score to call a box the same person
const TRACK_TIMEOUT_MS = 900;
const RECHECK_MS = 250; // re-identify an established track quickly without checking every frame forever
const SETTLE_CHECKS = 6; // identify fast on a brand new track: check every frame at first
// Box position and velocity are filtered separately, and both are specified as time constants
// rather than as a per-detection blend factor. A blend factor only means something at a fixed
// detection interval, and the interval here is neither fixed nor the same on every phone: it is
// 80-180 ms by schedule, longer on a slow device, and longer again whenever a detection is missed
// and the track coasts. With a time constant, both filters behave the same in seconds everywhere,
// a long gap is correctly weighted more than a short one, and a burst of two detections 10 ms
// apart cannot yank the estimate (small dt -> small blend), which is what kept the old fixed
// 0.68 from being safe to raise.
//
// Position: how far the drawn box trails a target moving at v px/s. For dt << tau the steady
// state lag is v * tau; for larger dt it is less, so tau is the worst case. Measured against the
// detector jitter model in test/motion.test.js (sigma = 0.87% of box height) at dt = 120 ms and
// v = 400 px/s: the old 0.68 was tau = 105 ms and trailed 22.6 px, with 1.9 px of visible box
// noise. 60 ms trails 7.5 px for 2.3 px of noise - a 3x lag cut for 22% more jitter. Going lower
// buys little: tau = 40 ms removes only another 5 px and takes the noise to 2.5 px, most of the
// detector's raw 2.6 px.
const BOX_SMOOTHING_TAU_MS = 60;
// Velocity: deliberately slower than the position filter, and measured from the *raw* detection
// centres rather than from the smoothed box (see updateTrackBox). Keeping the two separate is the
// point - track.vx/vy decide box-to-track association (predictedBox), where a noisy velocity
// causes identity swaps between people, and the overlay projects along them between detections,
// where noise lands straight on the screen and on the aim. In the same measurement, velocity
// noise on a standing person falls from 18 px/s rms (old, coupled at 0.68) to 12 px/s, where
// merely raising the old factor to 0.85 would have taken it to 24 px/s. 250 ms would halve it
// again, but velocity then needs a quarter second to notice someone reversing direction, which
// is the whole window the overlay projects over.
const VELOCITY_SMOOTHING_TAU_MS = 180;
// Over a longer gap than this, the straight line between two detections is not a velocity: a
// person can turn around within it. Keep the coasted estimate instead of inventing a confident
// wrong one. TRACK_TIMEOUT_MS lets a track coast more than twice this long.
const VELOCITY_MAX_GAP_MS = 400;
const MIN_FRAME_DT_S = 0.016; // never divide a displacement by less than about one frame
const PREDICT_MAX_AHEAD_S = 0.5; // how far association may extrapolate a track along its velocity
const COAST_VELOCITY_DECAY = 0.82; // velocity damping while a track is briefly unseen

// -- identity hysteresis: how reluctant a track is to take or change a name --
const INITIAL_STREAK = 2; // a new track must agree a couple of times before getting a name
const SWITCH_STREAK = 4; // a rival id must win this many checks in a row before we switch
const HIGH_CONFIDENCE_INITIAL_LOCK = 0.66; // colour-only equivalent of REID_INITIAL_LOCK

// -- evidence accumulation: a leaky bucket per candidate id, so one good frame isn't decisive --
const EVIDENCE_DECAY = 0.82; // per check, so old evidence fades within a second or so
const EVIDENCE_ACCEPT = 0.58; // bucket level at which the leader can name the track
const EVIDENCE_MARGIN = 0.12; // ...and by how much it must lead the runner-up
const EVIDENCE_MIN_SCORE = 0.42; // colour-path floor for a check to count as evidence
const EVIDENCE_MIN_PART = 0.24; // ...and the floor for each individual colour part
const EVIDENCE_WEIGHT_ACCEPTED = 1.25; // an accepted check is worth more than a near miss
const EVIDENCE_WEIGHT_SOFT = 0.45; // a near miss still counts, scaled by how near it was
const SOFT_LABEL_SCORE = 0.48; // colour-path equivalent of REID_SOFT_LABEL_SCORE

// ---- Signature extraction ----

let sampleCanvas = null;
function sourceWidth(source) {
  return source.videoWidth || source.width || 1;
}

function sourceHeight(source) {
  return source.videoHeight || source.height || 1;
}

function readPixels(source, box, w, h) {
  sampleCanvas ??= document.createElement('canvas');
  sampleCanvas.width = w;
  sampleCanvas.height = h;
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  const sx = Math.max(0, box.x);
  const sy = Math.max(0, box.y);
  const sw = Math.min(sourceWidth(source) - sx, box.w - (sx - box.x));
  const sh = Math.min(sourceHeight(source) - sy, box.h - (sy - box.y));
  if (sw <= 1 || sh <= 1) return new Uint8ClampedArray(w * h * 4);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function subBox(box, x, y, w, h) {
  return { x: box.x + box.w * x, y: box.y + box.h * y, w: box.w * w, h: box.h * h };
}

function boxMetrics(source, box) {
  const vw = sourceWidth(source);
  const vh = sourceHeight(source);
  const aspect = box.h / Math.max(1, box.w);
  const heightRatio = box.h / vh;
  const widthRatio = box.w / vw;
  const edgePad = Math.min(vw, vh) * BOX_EDGE_PAD_RATIO;
  const clipped =
    box.x <= edgePad || box.y <= edgePad || box.x + box.w >= vw - edgePad || box.y + box.h >= vh - edgePad;
  return { aspect, heightRatio, widthRatio, clipped };
}

// 'ok', or why this box is not worth a signature. The reason is shown to the player during
// enrolment ("step a little closer"), so the order of these checks is the order of advice.
function boxQuality(source, box, minHeightRatio, { scan = false } = {}) {
  const m = boxMetrics(source, box);
  const minWidthRatio = scan ? MIN_SCAN_BOX_WIDTH_RATIO : MIN_BOX_WIDTH_RATIO;
  const minAspect = scan ? MIN_SCAN_ASPECT : MIN_ASPECT;
  const maxAspect = scan ? MAX_SCAN_ASPECT : MAX_ASPECT;
  const clippedHeight = scan ? CLIPPED_OK_SCAN_HEIGHT_RATIO : CLIPPED_OK_HEIGHT_RATIO;
  if (m.heightRatio < minHeightRatio || m.widthRatio < minWidthRatio) return 'too-far';
  if (m.aspect < minAspect || m.aspect > maxAspect) return 'partial-body';
  if (m.clipped && m.heightRatio < clippedHeight) return 'edge-clipped';
  return 'ok';
}

function usableBox(source, box, minHeightRatio, options) {
  return boxQuality(source, box, minHeightRatio, options) === 'ok';
}

export function usableScanBox(source, box) {
  return usableBox(source, box, MIN_SCAN_HEIGHT_RATIO, { scan: true });
}

export function scanBoxProblem(source, box) {
  return box ? boxQuality(source, box, MIN_SCAN_HEIGHT_RATIO, { scan: true }) : 'no-person';
}

function usableMatchBox(source, box) {
  return usableBox(source, box, MIN_MATCH_HEIGHT_RATIO);
}

function rgbToHueSat(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (max === min) return [0, sat];
  const d = max - min;
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hue * 60 + 360) % 360, sat];
}

function normalize(vec) {
  let sumSq = 0;
  for (const v of vec) if (Number.isFinite(v)) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map((v) => (Number.isFinite(v) ? v / norm : 0));
}

function roundVector(vec, precision = EMBED_PRECISION) {
  return vec.map((v) => Math.round(v * precision) / precision);
}

function compactEmbedding(vec) {
  if (!vec?.length) return [];
  if (vec.length <= EMBED_DIMS) return roundVector(normalize(vec));
  const compact = new Array(EMBED_DIMS).fill(0);
  for (let i = 0; i < vec.length; i++) {
    const bucket = Math.min(EMBED_DIMS - 1, Math.floor((i / vec.length) * EMBED_DIMS));
    compact[bucket] += Number.isFinite(vec[i]) ? vec[i] : 0;
  }
  return roundVector(normalize(compact));
}

// Appearance histogram for one body region. The first 48 bins are hue/saturation for
// colourful clothing; the last 16 bins keep neutral clothing useful.
function appearanceHistogram(source, box) {
  const px = readPixels(source, box, 18, 24);
  const hist = new Array(HUE_BINS * SAT_BINS + LUMA_BINS + SAT_DETAIL_BINS).fill(0);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const [hue, sat] = rgbToHueSat(r, g, b);

    const hb = Math.min(HUE_BINS - 1, Math.floor((hue / 360) * HUE_BINS));
    const sb = Math.min(SAT_BINS - 1, Math.floor(sat * SAT_BINS));
    const sdb = Math.min(SAT_DETAIL_BINS - 1, Math.floor(sat * SAT_DETAIL_BINS));
    const lb = Math.min(LUMA_BINS - 1, Math.floor(luma * LUMA_BINS));

    if (sat >= 0.08) hist[hb * SAT_BINS + sb] += 0.4 + sat;
    hist[HUE_BINS * SAT_BINS + lb] += 0.8;
    hist[HUE_BINS * SAT_BINS + LUMA_BINS + sdb] += 0.45;
  }
  return normalize(hist);
}

// Coarse brightness/chroma grid over the central body box. Hue is encoded as sin/cos, weighted
// by saturation, so grey/black/white clothes do not invent meaningless hue features.
function bodyGrid(source, box) {
  const px = readPixels(source, subBox(box, 0.08, 0.06, 0.84, 0.88), GRID_W, GRID_H);
  const grid = new Array(GRID_W * GRID_H * GRID_FEATURES);
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    const r = px[i * 4] / 255;
    const g = px[i * 4 + 1] / 255;
    const b = px[i * 4 + 2] / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const [hue, sat] = rgbToHueSat(r, g, b);
    const radians = (hue / 180) * Math.PI;
    grid[i * GRID_FEATURES] = luma;
    grid[i * GRID_FEATURES + 1] = sat;
    grid[i * GRID_FEATURES + 2] = Math.cos(radians) * sat;
    grid[i * GRID_FEATURES + 3] = Math.sin(radians) * sat;
  }
  return normalize(grid);
}

function shapeSignature(source, box) {
  const { aspect, heightRatio, widthRatio } = boxMetrics(source, box);
  return [aspect, heightRatio / Math.max(widthRatio, 0.001)];
}

function embedRegion(source, box) {
  const sw = sourceWidth(source);
  const sh = sourceHeight(source);
  const padX = box.w * 0.08;
  const padTop = box.h * 0.04;
  const padBottom = box.h * 0.08;
  const left = Math.max(0, (box.x - padX) / sw);
  const top = Math.max(0, (box.y - padTop) / sh);
  const right = Math.min(1, (box.x + box.w + padX) / sw);
  const bottom = Math.min(1, (box.y + box.h + padBottom) / sh);
  return right - left > 0.02 && bottom - top > 0.02 ? { left, top, right, bottom } : null;
}

// Signal 2: the generic MobileNet embedding (detector.js builds the embedder). Synchronous and
// cheap enough to run inline, unlike reid.js. Returns [] when there is no embedder, no usable
// region, or inference failed, which is what makes it an optional blend rather than a dependency.
let embedTimestamp = 0;
function personEmbedding(source, box, embedder, timestamp) {
  if (!embedder) return [];
  const regionOfInterest = embedRegion(source, box);
  if (!regionOfInterest) return [];
  try {
    embedTimestamp = Math.max(embedTimestamp + 1, Math.round(timestamp ?? performance.now()));
    const result = embedder.embedForVideo(source, embedTimestamp, { regionOfInterest });
    const embedding = result.embeddings?.[0];
    if (embedding?.floatEmbedding?.length) return compactEmbedding(embedding.floatEmbedding);
    if (embedding?.quantizedEmbedding?.length) {
      return compactEmbedding(Array.from(embedding.quantizedEmbedding, (v) => (v - 128) / 128));
    }
  } catch (err) {
    console.warn('Embedding failed', err);
  }
  return [];
}

// { hist, lower, grid, embed } for one video frame + box. Used both at enrolment and live.
// `reid` is not set here: it is asynchronous, so the caller attaches it (see Tracker.update).
export function extractSignature(source, box, embedder = null, timestamp = performance.now()) {
  return {
    hist: appearanceHistogram(source, subBox(box, 0.16, 0.2, 0.68, 0.42)),
    lower: appearanceHistogram(source, subBox(box, 0.18, 0.58, 0.64, 0.34)),
    grid: bodyGrid(source, box),
    shape: shapeSignature(source, box),
    embed: personEmbedding(source, box, embedder, timestamp),
    usable: usableMatchBox(source, box),
  };
}

function averageVectors(vectors) {
  const len = Math.max(0, ...vectors.map((v) => v?.length ?? 0));
  const avg = new Array(len).fill(0);
  if (!len || !vectors.length) return avg;
  for (const vector of vectors) {
    for (let i = 0; i < len; i++) avg[i] += Number.isFinite(vector?.[i]) ? vector[i] : 0;
  }
  return normalize(avg.map((v) => v / vectors.length));
}

// One gallery entry out of several samples of the same person at (roughly) the same angle.
export function averageSignatures(signatures) {
  return {
    hist: averageVectors(signatures.map((s) => s.hist)),
    lower: averageVectors(signatures.map((s) => s.lower)),
    grid: averageVectors(signatures.map((s) => s.grid)),
    shape: averageVectors(signatures.map((s) => s.shape)),
    embed: averageVectors(signatures.map((s) => s.embed).filter((v) => v?.length)),
    reid: averageVectors(signatures.map((s) => s.reid).filter((v) => v?.length)),
    usable: signatures.some((s) => s.usable !== false),
  };
}

// ---- Gallery matching ----

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const av = Number.isFinite(a[i]) ? a[i] : 0;
    const bv = Number.isFinite(b[i]) ? b[i] : 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function shapeSimilarity(a, b) {
  const aspectA = a?.[0];
  const aspectB = b?.[0];
  if (!Number.isFinite(aspectA) || !Number.isFinite(aspectB) || aspectA <= 0 || aspectB <= 0) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(aspectA / aspectB)) / Math.log(2.2));
}

// One live signature against one enrolled sample. This is where the fallback chain described at
// the top of the file actually happens: see `score`.
function similarityParts(a, b) {
  const upper = cosine(a.hist, b.hist);
  const lower = cosine(a.lower, b.lower);
  const grid = cosine(a.grid, b.grid);
  const shape = shapeSimilarity(a.shape, b.shape);
  const embed = cosine(a.embed, b.embed);
  const hasEmbed = Boolean(a.embed?.length && b.embed?.length);
  // With a re-identification embedding on both sides, it alone decides: in evaluation, blending
  // in the colour features only made it worse (reid.js). The colour parts stay for debugging.
  const hasReid = Boolean(a.reid?.length && b.reid?.length);
  const reid = hasReid ? cosine(a.reid, b.reid) : 0;
  return {
    upper,
    lower,
    grid,
    shape,
    embed,
    reid,
    hasReid,
    score: hasReid
      ? reid
      : hasEmbed
      ? EMBED_HIST_WEIGHT * upper +
        EMBED_LOWER_WEIGHT * lower +
        EMBED_GRID_WEIGHT * grid +
        EMBED_SHAPE_WEIGHT * shape +
        EMBED_WEIGHT * embed
      : HIST_WEIGHT * upper + LOWER_WEIGHT * lower + GRID_WEIGHT * grid + SHAPE_WEIGHT * shape,
  };
}

function averageMatches(matches) {
  const totals = { upper: 0, lower: 0, grid: 0, shape: 0, embed: 0, score: 0 };
  for (const match of matches) {
    totals.upper += match.upper;
    totals.lower += match.lower;
    totals.grid += match.grid;
    totals.shape += match.shape;
    totals.embed += match.embed;
    totals.score += match.score;
  }
  const n = matches.length || 1;
  return {
    upper: totals.upper / n,
    lower: totals.lower / n,
    grid: totals.grid / n,
    shape: totals.shape / n,
    embed: totals.embed / n,
    score: totals.score / n,
  };
}

// A single enrolled angle can be noisy, so matching blends the best angle with nearby
// supporting angles. This keeps side/front tolerance while reducing wins from one bad sample.
function bestAngleScore(signature, gallery) {
  if (signature.usable === false) return null;
  const matches = [];
  for (let i = 0; i < gallery.length; i++) {
    const sample = gallery[i];
    if (!sample?.hist?.length || !sample?.grid?.length || !sample?.lower?.length || !sample?.shape?.length) continue;
    matches.push({ ...similarityParts(signature, sample), angleIndex: i });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];
  const agreeing = matches
    .filter((match) => best.score - match.score <= GALLERY_AGREEMENT_WINDOW)
    .slice(0, GALLERY_TOP_MATCH_COUNT);
  const agreement = averageMatches(agreeing);
  const supportBonus = Math.min(agreeing.length - 1, GALLERY_TOP_MATCH_COUNT - 1) * GALLERY_SUPPORT_BONUS;
  return {
    ...best,
    score: best.score * (1 - GALLERY_AGREEMENT_WEIGHT) + agreement.score * GALLERY_AGREEMENT_WEIGHT + supportBonus,
    angleScore: best.score,
    agreementScore: agreement.score,
    agreementCount: agreeing.length,
  };
}

// null when the best candidate is good enough, otherwise which gate it failed. Note that the
// re-identification path checks score and margin only: the colour part minimums below exist to
// prop up a weak signal, and applying them to a stronger one just rejects correct matches.
function rejectionReason(best, candidates, secondScore) {
  if (!best) return 'no-candidate';
  if (best.hasReid) {
    if (best.score < REID_MATCH_THRESHOLD) return 'score';
    if (candidates > 1 && best.score - secondScore < REID_MATCH_MARGIN) return 'margin';
    return null;
  }
  if (best.score < MATCH_THRESHOLD) return 'score';
  if (best.upper < MIN_UPPER_SCORE) return 'upper';
  if (best.lower < MIN_LOWER_SCORE) return 'lower';
  if (best.grid < MIN_GRID_SCORE) return 'grid';
  if (best.shape < MIN_SHAPE_SCORE) return 'shape';
  if (candidates > 1 && best.score - secondScore < MATCH_MARGIN) return 'margin';
  return null;
}

// players: [{ id, name, gallery: [{hist, grid}, ...] }, ...]
// excludeId: the local player - never matched against their own gallery.
export function matchGallery(signature, players, excludeId, { includeRejected = false, closedSet = false } = {}) {
  const rankings = [];
  for (const player of players) {
    if ((!closedSet && player.id === excludeId) || !player.gallery?.length) continue;
    const match = bestAngleScore(signature, player.gallery);
    if (!match) continue;
    rankings.push({ id: player.id, name: player.name, ...match });
  }
  rankings.sort((a, b) => b.score - a.score);
  for (let i = 0; i < rankings.length; i++) {
    const rival = i === 0 ? rankings[1] : rankings[0];
    rankings[i].margin = rankings[i].score - (rival?.score ?? 0);
  }
  const best = rankings[0] ?? null;
  const candidates = rankings.length;
  const secondScore = rankings[1]?.score ?? -Infinity;
  const reason = rejectionReason(best, candidates, secondScore);
  if (best?.id === excludeId) {
    const selfMatch = { ...best, accepted: false, reason: 'self', candidates, rankings };
    return includeRejected || closedSet ? selfMatch : null;
  }
  // Closed set assumes everyone visible is a player and takes the best match even below the
  // thresholds - fine for weak colour features, but it's what made the classifier label
  // bystanders as players. Re-identification scores are reliable enough to keep the thresholds.
  if (closedSet && best) return { ...best, accepted: best.hasReid ? !reason : true, reason, candidates, rankings };
  if (!reason) return { ...best, accepted: true, candidates };
  return includeRejected && best ? { ...best, accepted: false, reason, candidates, rankings } : null;
}

// ---- Per-frame tracking ----

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function center(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function centerScore(a, b) {
  const ac = center(a);
  const bc = center(b);
  const distance = Math.hypot(ac.x - bc.x, ac.y - bc.y);
  const scale = Math.max(a.w, a.h, b.w, b.h, 1);
  return Math.max(0, 1 - distance / (scale * 1.35));
}

function sizeScore(a, b) {
  const aw = Math.max(1, a.w);
  const ah = Math.max(1, a.h);
  const bw = Math.max(1, b.w);
  const bh = Math.max(1, b.h);
  const width = Math.min(aw, bw) / Math.max(aw, bw);
  const height = Math.min(ah, bh) / Math.max(ah, bh);
  return (width + height) / 2;
}

function blendBox(a, b, alpha) {
  return {
    x: a.x * (1 - alpha) + b.x * alpha,
    y: a.y * (1 - alpha) + b.y * alpha,
    w: a.w * (1 - alpha) + b.w * alpha,
    h: a.h * (1 - alpha) + b.h * alpha,
    score: b.score,
  };
}

// Blend factor for a one-pole filter with time constant `tauMs`, sampled `dtS` seconds after the
// last one. dtS -> 0 gives 0 (nothing new to learn yet), dtS >> tau gives ~1 (the old estimate is
// stale, take the measurement).
function smoothingAlpha(dtS, tauMs) {
  return 1 - Math.exp((-dtS * 1000) / tauMs);
}

// Where the detector last actually saw this track, rather than where its drawn box has smoothed
// to. Association is predicting the *next measurement*, and measurements are unsmoothed, so
// starting from the smoothed box would put every prediction a fixed BOX_SMOOTHING_TAU_MS behind.
// Falls back to the drawn box for a track that has not been through updateTrackBox yet.
function measuredBox(track) {
  const measured = track.measuredCenter;
  if (!measured) return track.box;
  return { ...track.box, x: measured.x - track.box.w / 2, y: measured.y - track.box.h / 2 };
}

function predictedBox(track, now) {
  const dt = Math.min(PREDICT_MAX_AHEAD_S, Math.max(0, (now - (track.lastUpdated || track.lastSeen || now)) / 1000));
  const base = measuredBox(track);
  return {
    ...base,
    x: base.x + (track.vx ?? 0) * dt,
    y: base.y + (track.vy ?? 0) * dt,
  };
}

// How much this box looks like the next observation of this track: mostly overlap, then how far
// the centre moved, then a little for keeping the same size. The early return rejects pairs that
// neither overlap nor sit close enough to be the same person, however similar their size.
function associationScore(track, box, now) {
  const predicted = predictedBox(track, now);
  const overlap = iou(predicted, box);
  const distance = centerScore(predicted, box);
  if (overlap < 0.08 && distance < 0.35) return 0;
  return overlap * 0.5 + distance * 0.35 + sizeScore(predicted, box) * 0.15;
}

// Fold one detection into a track: the box that gets drawn, and the velocity, filtered
// independently of each other. Velocity is measured between consecutive *raw* detection centres
// and smoothed on its own, so loosening the position filter to cut display lag does not make
// velocity noisier - inferring it from the smoothed box, as this used to, tied the two together
// and meant any reduction in lag was paid for in association quality and in aim.
function updateTrackBox(track, box, now) {
  const elapsed = now - (track.lastUpdated || track.lastSeen || now);
  const dt = Math.max(MIN_FRAME_DT_S, elapsed / 1000);
  const measured = center(box);
  const previous = track.measuredCenter ?? center(track.box);
  if (elapsed <= VELOCITY_MAX_GAP_MS) {
    const alpha = smoothingAlpha(dt, VELOCITY_SMOOTHING_TAU_MS);
    track.vx = (track.vx ?? 0) + alpha * ((measured.x - previous.x) / dt - (track.vx ?? 0));
    track.vy = (track.vy ?? 0) + alpha * ((measured.y - previous.y) / dt - (track.vy ?? 0));
  }
  track.measuredCenter = measured;
  track.box = blendBox(track.box, box, smoothingAlpha(dt, BOX_SMOOTHING_TAU_MS));
  track.lastSeen = now;
  track.lastUpdated = now;
  track.seenThisFrame = true;
  track.missedFrames = 0;
  track.checks++;
}

// How much to trust this track's name, used only to break ties between two tracks claiming the
// same player: the score it was named on, plus supporting evidence and a long history, minus
// failed checks and staleness.
function identityConfidence(track, now) {
  if (!track.playerId) return -Infinity;
  const evidence = track.evidence?.get(track.playerId) ?? 0;
  const stalePenalty = Math.max(0, now - track.lastSeen) / 1000;
  return track.score + evidence * 0.08 + Math.min(track.checks, 10) * 0.01 - Math.min(track.misses, 4) * 0.04 - stalePenalty * 0.25;
}

function clearIdentity(track) {
  track.playerId = null;
  track.name = null;
  track.score = 0;
  track.upper = 0;
  track.lower = 0;
  track.grid = 0;
  track.shape = 0;
  track.embed = 0;
  track.reid = 0;
  track.hasReid = false;
  track.rankings = [];
  track.streak = 0;
  track.streakId = undefined;
  track.identifiedAt = null;
  track.identityHits = 0;
  track.lastEnrichedAt = 0;
  track.selfRejected = false;
}

// One player can only be in one place: if two tracks ended up with the same name, the better
// supported one keeps it and the other goes back to being an unidentified person.
function resolveDuplicateIdentities(tracks, now) {
  const byPlayer = new Map();
  for (const track of tracks) {
    if (!track.playerId) continue;
    const list = byPlayer.get(track.playerId) ?? [];
    list.push(track);
    byPlayer.set(track.playerId, list);
  }
  for (const duplicates of byPlayer.values()) {
    if (duplicates.length < 2) continue;
    duplicates.sort((a, b) => {
      const seenDelta = Number(Boolean(b.seenThisFrame)) - Number(Boolean(a.seenThisFrame));
      if (seenDelta) return seenDelta;
      const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
      return Math.abs(scoreDelta) > 0.0001 ? scoreDelta : identityConfidence(b, now) - identityConfidence(a, now);
    });
    for (const duplicate of duplicates.slice(1)) clearIdentity(duplicate);
  }
}

// With several people on screen at once, deciding each track on its own throws away the
// strongest hint available: the same player cannot be two of them. This assigns players to
// tracks greedily over all (track, candidate) pairs instead, nudged by stickiness to the current
// name, accumulated evidence, how clearly that candidate beat its rivals, and how many enrolled
// angles agreed. Tracks left without a player become unidentified people.
function resolveClosedSetIdentities(tracks, now, selfId) {
  const visible = tracks.filter((track) => track.lastSeen === now && !track.selfRejected && track.rankings?.length);
  if (visible.length < 2) return;

  const pairs = [];
  for (const track of visible) {
    for (const candidate of track.rankings) {
      if (candidate.id === selfId) continue;
      const sticky = candidate.id === track.playerId ? 0.035 : 0;
      const evidence = (track.evidence?.get(candidate.id) ?? 0) * 0.025;
      const margin = Number.isFinite(candidate.margin) ? Math.max(-0.12, Math.min(0.12, candidate.margin)) * 0.35 : 0;
      const agreement = Math.min(candidate.agreementCount ?? 1, GALLERY_TOP_MATCH_COUNT) * 0.006;
      pairs.push({ track, candidate, score: candidate.score + margin + sticky + evidence + agreement });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const usedTracks = new Set();
  const usedPlayers = new Set();
  for (const { track, candidate } of pairs) {
    if (usedTracks.has(track) || usedPlayers.has(candidate.id)) continue;
    assignIdentity(track, candidate);
    usedTracks.add(track);
    usedPlayers.add(candidate.id);
  }

  for (const track of visible) {
    if (!usedTracks.has(track)) clearIdentity(track);
  }
}

function decayEvidence(track) {
  for (const [id, value] of track.evidence) {
    const decayed = value * EVIDENCE_DECAY;
    if (decayed < 0.05) track.evidence.delete(id);
    else track.evidence.set(id, decayed);
  }
}

// What one check is worth as evidence: nothing at all below the floors, more when it was
// accepted outright, and otherwise scaled by how far above the floor it got.
function evidenceWeight(match) {
  if (!match) return 0;
  if (match.hasReid) {
    if (match.score < REID_EVIDENCE_MIN_SCORE) return 0;
    return match.accepted ? EVIDENCE_WEIGHT_ACCEPTED : EVIDENCE_WEIGHT_SOFT + Math.max(0, match.score - REID_EVIDENCE_MIN_SCORE);
  }
  if (
    match.score < EVIDENCE_MIN_SCORE ||
    match.upper < EVIDENCE_MIN_PART ||
    match.lower < EVIDENCE_MIN_PART ||
    match.grid < EVIDENCE_MIN_PART ||
    match.shape < EVIDENCE_MIN_PART
  ) {
    return 0;
  }
  return match.accepted ? EVIDENCE_WEIGHT_ACCEPTED : EVIDENCE_WEIGHT_SOFT + Math.max(0, match.score - EVIDENCE_MIN_SCORE);
}

// A rejected match that is still worth proposing to the streak logic. A 'margin' rejection is
// never soft-labelled: two players scoring the same is a tie, and guessing is worse than waiting.
function softLabelMatch(match) {
  if (!match || match.accepted || match.reason === 'margin') return null;
  if (match.hasReid) return match.score >= REID_SOFT_LABEL_SCORE ? { ...match, soft: true } : null;
  if (match.score < SOFT_LABEL_SCORE) return null;
  if (
    match.upper < EVIDENCE_MIN_PART ||
    match.lower < EVIDENCE_MIN_PART ||
    match.grid < EVIDENCE_MIN_PART ||
    match.shape < EVIDENCE_MIN_PART
  ) {
    return null;
  }
  return { ...match, soft: true };
}

function trackerCandidate(match, evidenceMatch) {
  return match?.accepted ? match : evidenceMatch ?? softLabelMatch(match);
}

function addEvidence(track, match) {
  const weight = evidenceWeight(match);
  if (!weight) return;
  track.evidence.set(match.id, (track.evidence.get(match.id) ?? 0) + weight);
  track.evidenceDetails.set(match.id, match);
}

function evidenceWinner(track) {
  let best = null;
  let second = 0;
  for (const [id, value] of track.evidence) {
    if (!best || value > best.value) {
      if (best) second = best.value;
      best = { id, value };
    } else if (value > second) {
      second = value;
    }
  }
  if (!best || best.value < EVIDENCE_ACCEPT || best.value - second < EVIDENCE_MARGIN) return null;
  return track.evidenceDetails.get(best.id) ?? null;
}

function assignIdentity(track, match) {
  const previousId = track.playerId;
  track.selfRejected = false;
  track.playerId = match?.id ?? null;
  track.name = match?.name ?? null;
  track.score = match?.score ?? 0;
  track.upper = match?.upper ?? 0;
  track.lower = match?.lower ?? 0;
  track.grid = match?.grid ?? 0;
  track.shape = match?.shape ?? 0;
  track.embed = match?.embed ?? 0;
  track.reid = match?.hasReid ? match.reid : 0;
  track.hasReid = Boolean(match?.hasReid);
  track.misses = 0;
  if (match?.id) {
    track.identifiedAt = previousId === match.id ? (track.identifiedAt ?? track.lastSeen) : track.lastSeen;
    track.identityHits = previousId === match.id ? (track.identityHits ?? 0) + 1 : 1;
  } else {
    track.identifiedAt = null;
    track.identityHits = 0;
  }
  track.streak = 0;
  track.streakId = undefined;
}

// Tracks people across frames (cheap IOU matching) and only re-runs identification per track
// on a schedule, not on every box of every frame. This is what keeps per-frame cost low even
// with several people on screen: identity rides along with the track between checks, and a
// sticky/hysteresis rule (SWITCH_STREAK) stops single ambiguous frames from flipping it.
export class Tracker {
  constructor() {
    this.tracks = [];
    this.nextId = 1;
  }

  // boxes: detectPeople() output. players: room roster with galleries. selfId: the local player.
  update(
    boxes,
    video,
    players,
    selfId,
    now = performance.now(),
    { includeRejected = false, embedder = null, reid = null, identifyOnce = false, closedSet = false } = {},
  ) {
    for (const track of this.tracks) track.seenThisFrame = false;

    // Associate boxes to tracks: score every plausible pair, then take them best-first, so one
    // box cannot be claimed by two tracks and vice versa.
    const pairs = [];
    for (const track of this.tracks) {
      for (let i = 0; i < boxes.length; i++) {
        const score = associationScore(track, boxes[i], now);
        if (score >= ASSOCIATION_MATCH) pairs.push({ track, boxIndex: i, score });
      }
    }

    pairs.sort((a, b) => b.score - a.score);
    const matchedTracks = new Set();
    const matchedBoxes = new Set();
    for (const pair of pairs) {
      if (matchedTracks.has(pair.track) || matchedBoxes.has(pair.boxIndex)) continue;
      updateTrackBox(pair.track, boxes[pair.boxIndex], now);
      matchedTracks.add(pair.track);
      matchedBoxes.add(pair.boxIndex);
    }

    // Tracks the detector missed this frame coast on their last velocity for a moment: a person
    // the detector drops for two frames should not become a new, unidentified person.
    for (const track of this.tracks) {
      if (track.seenThisFrame) continue;
      const age = now - track.lastSeen;
      if (age < TRACK_TIMEOUT_MS) {
        track.vx = (track.vx ?? 0) * COAST_VELOCITY_DECAY;
        track.vy = (track.vy ?? 0) * COAST_VELOCITY_DECAY;
        track.missedFrames = (track.missedFrames ?? 0) + 1;
      }
    }

    for (let i = 0; i < boxes.length; i++) {
      if (matchedBoxes.has(i)) continue;
      this.tracks.push({
        id: this.nextId++,
        box: boxes[i],
        // The raw detection centre, kept alongside the smoothed box so velocity and association
        // can work from the measurements (updateTrackBox, measuredBox).
        measuredCenter: center(boxes[i]),
        lastSeen: now,
        lastUpdated: now,
        seenThisFrame: true,
        vx: 0,
        vy: 0,
        checks: 1,
        lastCheck: 0,
        playerId: null,
        name: null,
        score: 0,
        upper: 0,
        lower: 0,
        grid: 0,
        shape: 0,
        embed: 0,
        reid: 0,
        hasReid: false,
        rankings: [],
        debugMatch: null,
        evidence: new Map(),
        evidenceDetails: new Map(),
        streakId: undefined,
        streak: 0,
        misses: 0,
        missedFrames: 0,
        identifiedAt: null,
        identityHits: 0,
        lastEnrichedAt: 0,
        selfRejected: false,
      });
    }
    this.tracks = this.tracks.filter((t) => now - t.lastSeen < TRACK_TIMEOUT_MS);

    for (const track of this.tracks) {
      if (track.lastSeen !== now) continue; // not seen this frame, nothing to re-check
      const due =
        !track.playerId ||
        (!identifyOnce && (track.checks <= SETTLE_CHECKS || now - track.lastCheck >= RECHECK_MS));
      if (!due) continue;
      track.lastCheck = now;

      const signature = extractSignature(video, track.box, embedder, now);
      if (reid) {
        // Re-identification runs in the background: use this track's latest embedding and ask
        // for a fresh one. Until its first embedding arrives, don't identify the track from
        // colours alone - that's how bystanders used to get labelled as players.
        signature.reid = reid.latest(track);
        reid.request(track, video, track.box);
        if (!signature.reid) continue;
      }
      const match = matchGallery(signature, players, selfId, { includeRejected: true, closedSet });
      track.rankings = match?.rankings ?? (match ? [match] : []);
      if (match?.reason === 'self' && match.id === selfId) {
        // The camera is looking at its own owner (a mirror, or a mis-scan). Drop the identity and
        // the evidence for it, but keep the rankings so the debug overlay can show what happened.
        const rankings = track.rankings;
        clearIdentity(track);
        track.evidence.clear();
        track.evidenceDetails.clear();
        track.rankings = rankings;
        track.debugMatch = match;
        track.selfRejected = true;
        continue;
      }
      track.selfRejected = false;
      decayEvidence(track);
      addEvidence(track, match);
      const evidenceMatch = evidenceWinner(track);
      const candidateMatch = trackerCandidate(match, evidenceMatch);
      const candidateId = candidateMatch?.id ?? null;
      track.debugMatch = includeRejected && !match?.accepted ? (match ?? null) : null;

      if (!candidateId) {
        track.misses++;
        // Once a physical track has a trusted identity, keep it latched. Appearance checks
        // can fail for normal gameplay reasons: motion blur, side views, lighting, occlusion,
        // or only part of the player being visible. A known box should only lose/change its
        // identity when the track disappears, a duplicate conflict is resolved, or another
        // player wins the switch hysteresis below.
        track.streak = 0;
        track.streakId = undefined;
      } else if (candidateId === track.playerId) {
        assignIdentity(track, candidateMatch);
      } else if (candidateId === track.streakId) {
        track.streak++;
        const needed = track.playerId ? SWITCH_STREAK : INITIAL_STREAK;
        if (track.streak >= needed) assignIdentity(track, candidateMatch);
      } else {
        track.streakId = candidateId;
        track.streak = 1;
        if (
          !track.playerId &&
          candidateMatch?.accepted &&
          candidateMatch.score >= (candidateMatch.hasReid ? REID_INITIAL_LOCK : HIGH_CONFIDENCE_INITIAL_LOCK)
        ) {
          assignIdentity(track, candidateMatch);
        }
      }
    }
    if (closedSet) resolveClosedSetIdentities(this.tracks, now, selfId);
    resolveDuplicateIdentities(this.tracks, now);
    return this.tracks;
  }
}
