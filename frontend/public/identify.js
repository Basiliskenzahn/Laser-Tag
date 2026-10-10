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
//      is not part of the per-sample score in matchGallery; the Tracker nudges a track's typical
//      score for a player up or down when that player's phone clearly does or doesn't move with
//      it (the `scoreAdjust` option, motion-identity.js), and fuseMotion then confirms or vetoes
//      the identity a track carries, so it can back up a weak appearance match or veto a
//      bystander who happens to dress like a player.
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
export const MIN_MATCH_HEIGHT_RATIO = 0.18;
const MIN_BOX_WIDTH_RATIO = 0.035;
const MIN_SCAN_BOX_WIDTH_RATIO = 0.025;
const MIN_ASPECT = 0.58;
const MAX_ASPECT = 6.5;
const MIN_SCAN_ASPECT = 0.65;
const MAX_SCAN_ASPECT = 7.0;
const BOX_EDGE_PAD_RATIO = 0.01; // how close to the frame edge counts as touching it
const CLIPPED_OK_HEIGHT_RATIO = 0.55; // a box touching the edge is still usable once it's this tall
const CLIPPED_OK_SCAN_HEIGHT_RATIO = 0.42;

// -- the far band: how much below MIN_MATCH_HEIGHT_RATIO re-identification alone may still try --
// MIN_MATCH_HEIGHT_RATIO refuses a signature outright, at any score, so a player past roughly
// 10-12 m was never identified: 0.18 of a 720p frame is 130 px, which is a 1.7 m person at about
// that distance through a ~45 degrees vertical field of view. The limit is only real for the
// colour features, though - re-identification (signal 1) is the one signal trained across scales.
//
// Both floors are the point where the crop stops carrying detail for *that model*, read off its
// own input size (reid.js: 128 x 256). The existing gate already says what an acceptable upscale
// is: 0.18 x 720 = 130 px into a 256 px input is 1.97x, and the matching width floor,
// MIN_BOX_WIDTH_RATIO x 1280 = 45 px into 128 px, is 2.8x. One more octave of upscale - 4x, so a
// quarter of the linear detail and a sixteenth of the pixels the model expects - is where a
// standing person's distinguishing bands (the shirt/trouser split, hair, a logo) drop under about
// 8 px tall, which is also where a single pixel of detector box jitter moves them by more than one
// band. So:
//   height: 256 / 4 = 64 px, 64 / 720  = 0.089 -> 0.09, exactly half of MIN_MATCH_HEIGHT_RATIO
//   width:  128 / 4 = 32 px, 32 / 1280 = 0.025 (which is MIN_SCAN_BOX_WIDTH_RATIO, independently)
//
// Which of the two binds depends on how slim the box is, and for a standing person it is the width
// one: at an aspect of 2.5 in a 16:9 frame a box's width ratio is its height ratio / 4.44, so 32 px
// wide is reached at 0.111 of frame height while 64 px tall is still 0.089 away. The band therefore
// reaches about 0.111 for someone standing - 1.6x the current range, so 10-12 m becomes 16-19 m -
// and all the way to 0.09 for the squatter boxes (crouching, half a body in frame) where height is
// the axis that runs out first. That asymmetry is the detector's box shape, not a fudge: the 128 x
// 256 input is 1:2, a person is nearer 1:2.5, so width is the axis the model upsamples hardest.
// Below the band nothing is attempted and nothing is spent - see Tracker.update, which also stops
// asking reid.js for an embedding there.
export const FAR_REID_MIN_HEIGHT_RATIO = 0.09;
export const FAR_REID_MIN_WIDTH_RATIO = 0.025;
// A box in the band has to clear *more* than REID_DEFAULT_THRESHOLD, not less: the crop is mostly
// interpolation, so its score is less trustworthy and the bar goes up. At the floor the penalty is
// this, putting the requirement at 0.65 + 0.11 = 0.76 - the strictest row in the measured table
// below (3.1% bystanders accepted), and still under reidInitialLock(), so a far track can never be
// named on one check alone. The penalty is the normalised shortfall *squared*: it has zero slope at
// 0.18, so a detector box jittering across the line behaves the same on both sides, and it grows
// toward the floor roughly as the crop's pixel count falls away.
export const FAR_REID_MAX_PENALTY = 0.11;

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
// 0.36 was chosen against a `shape` that always returned 0 (see averageSignatures), so it has
// never actually gated anything. It is left as it was on purpose: the normalisation fix makes the
// gate *reachable*, and picking a new number needs real colour-only score distributions from a
// phone, not the synthetic ones in docs/shape-normalisation-evaluation.md.
// Exported only so tools/shape-evaluation.mjs can report against the live value instead of a
// mirror of its own: a retune here has to reach the harness, or it measures a gate the game no
// longer uses. Exporting is not permission to change it.
export const MIN_SHAPE_SCORE = 0.36;

// -- re-identification thresholds (cosine similarity of OSNet embeddings) --
// Chosen on Market-1501 in simulated games of 2-4 players, in the game's closed-set mode, per
// single check:
//   threshold 0.70 / 0.72 / 0.74 / 0.76 -> players recognised 87% / 83% / 77% / 71%,
//   bystanders accepted 10.8% / 7.6% / 4.9% / 3.1%, wrong player 0.3-0.5%.
// The tracker also needs agreeing checks before it names a track, so per person it's lower - see
// reid.js's header for the resulting *game-level* number (77% recognised at 5% bystander
// acceptance), which is lower than the 83%/7.6% above because it is not the same measurement.
// The margin halves wrong-player assignments.
//
//
// Real phones score players lower than the benchmark (the scan is taken by another phone, in other
// light): 0.80 recognised nobody in a real test. With the median below, real games put players at
// 0.70-0.80+ and non-players at 0.60-0.65; 0.70 and 0.68 had no false positives, so the default
// is 0.65 for fewer missed players. If bystanders start getting named, go back up with
// ?reid=0.68. Evidence and soft labels are now tied to it (they used to name anyone above fixed 0.62 / 0.66 and let false
// positives through regardless of the threshold). Tune it in the field with ?reid=0.70 in the
// address (env.js); ?debug shows each person's best score on their box.
const REID_DEFAULT_THRESHOLD = 0.65;
let reidMatchThreshold = REID_DEFAULT_THRESHOLD;

export function setReidThreshold(value) {
  if (Number.isFinite(value) && value >= 0.4 && value <= 0.95) reidMatchThreshold = value;
}

export function getReidThreshold() {
  return reidMatchThreshold;
}

// The re-identification score one check has to clear. The plain threshold for a box that passed
// MIN_MATCH_HEIGHT_RATIO - `rangePenalty` is absent, and absent is 0 - and the threshold plus the
// far-band penalty for one that did not (see FAR_REID_MAX_PENALTY and matchRange).
const reidScoreFloor = (match) => reidMatchThreshold + (match?.rangePenalty ?? 0);

// A named track whose re-identification score for its own player drops below this on several
// checks in a row is someone else now (people walking past each other, the player leaving and a
// bystander stepping into the same spot): the name is dropped instead of staying latched.
const REID_REVOKE_SCORE = 0.6;
const REID_REVOKE_CHECKS = 3;
const REID_MATCH_MARGIN = 0.03;
// Evidence, soft labels and shots all use the threshold itself. They used to accept scores a
// little under it, to bridge single bad checks; the 3 s median (REID_HISTORY_MS) does that now,
// and at a threshold of 0.65 those allowances reached into the non-player range (0.60-0.65), so
// someone who usually scored 0.63 slowly built up evidence and got named.
const reidEvidenceMinScore = () => reidMatchThreshold;
const reidSoftLabelScore = () => reidMatchThreshold;
// A shot needs the named track's score at least this high (motion-identity.js isStableTarget).
export const reidTargetMinScore = () => reidMatchThreshold;
// Name a brand new track on a single check this strong.
const reidInitialLock = () => Math.max(0.8, reidMatchThreshold + 0.08);
// One check can spike (a bystander turned at just the right angle) or dip (motion blur, a side
// view), so a track decides on its *typical* score for each player: the median of its scores over
// the last few seconds. Someone who usually scores 0.62 and hits 0.77 for a moment stays unnamed;
// a player who usually scores 0.82 and dips to 0.60 once stays named and shootable.
const REID_HISTORY_MS = 3000;

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
const HIGH_CONFIDENCE_INITIAL_LOCK = 0.66; // colour-only equivalent of reidInitialLock()

// -- evidence accumulation: a leaky bucket per candidate id, so one good frame isn't decisive --
const EVIDENCE_DECAY = 0.82; // per check, so old evidence fades within a second or so
const EVIDENCE_ACCEPT = 0.58; // bucket level at which the leader can name the track
const EVIDENCE_MARGIN = 0.12; // ...and by how much it must lead the runner-up
// Exported for the same reason as MIN_SHAPE_SCORE, and equally not up for retuning here.
export const EVIDENCE_MIN_SCORE = 0.42; // colour-path floor for a check to count as evidence
// ...and the floor for each individual colour part. `shape` used to be stuck at 0 here too, which
// meant no check without a re-identification embedding counted as evidence at all; left unchanged
// for the same reason as MIN_SHAPE_SCORE, so the fix restores the accumulator rather than retuning
// it.
export const EVIDENCE_MIN_PART = 0.24;
const EVIDENCE_WEIGHT_ACCEPTED = 1.25; // an accepted check is worth more than a near miss
const EVIDENCE_WEIGHT_SOFT = 0.45; // a near miss still counts, scaled by how near it was
const SOFT_LABEL_SCORE = 0.48; // colour-path equivalent of reidSoftLabelScore()

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
function boxQuality(source, box, minHeightRatio, { scan = false, minWidthRatio } = {}) {
  const m = boxMetrics(source, box);
  minWidthRatio ??= scan ? MIN_SCAN_BOX_WIDTH_RATIO : MIN_BOX_WIDTH_RATIO;
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

// Where a live box sits relative to the match gates, and what that costs it:
//
//   'ok'            passed boxQuality outright. penalty 0, and everything downstream behaves
//                   exactly as it did before the far band existed.
//   'far-reid'      too small for the colour features but inside the band, so re-identification
//                   may still try it against a stricter score (penalty > 0, see bestAngleScore).
//   'below-floor'   under FAR_REID_MIN_HEIGHT_RATIO or FAR_REID_MIN_WIDTH_RATIO: no path can use
//                   this box, so no path - and no OSNet inference - is spent on it.
//   'partial-body'  }  boxQuality's two non-distance refusals, unchanged. They are reported
//   'edge-clipped'  }  as-is rather than folded into the distance ones.
//
// Only the *height* gate relaxes. A box that is tall enough but failed on width is a sliver, not a
// distant person, and a sliver is under the floor however far away it is.
function matchRange(source, box) {
  const quality = boxQuality(source, box, MIN_MATCH_HEIGHT_RATIO);
  if (quality !== 'too-far') return { range: quality, penalty: 0 };
  const { heightRatio } = boxMetrics(source, box);
  if (heightRatio >= MIN_MATCH_HEIGHT_RATIO) return { range: 'below-floor', penalty: 0 };
  const far = boxQuality(source, box, FAR_REID_MIN_HEIGHT_RATIO, { minWidthRatio: FAR_REID_MIN_WIDTH_RATIO });
  if (far === 'too-far') return { range: 'below-floor', penalty: 0 };
  if (far !== 'ok') return { range: far, penalty: 0 };
  const shortfall = (MIN_MATCH_HEIGHT_RATIO - heightRatio) / (MIN_MATCH_HEIGHT_RATIO - FAR_REID_MIN_HEIGHT_RATIO);
  return { range: 'far-reid', penalty: FAR_REID_MAX_PENALTY * shortfall * shortfall };
}

// Why live boxes were refused a signature, since the last reset. Plain integer increments on a
// path that already runs once per check (Tracker.update), so it is cheap enough to leave on; the
// ?debug range readout reads it. The shape is fixed even when a counter never moves.
const rangeCounts = { ok: 0, tooFar: 0, farReid: 0, belowFloor: 0, partialBody: 0, edgeClipped: 0 };

// `allowed` only means anything for the far band: whether re-identification got far enough to
// produce a ranking at all, which is what separates a box the band rescued from one it refused.
function countRange(signature, allowed) {
  switch (signature?.range) {
    case 'ok':
      rangeCounts.ok++;
      break;
    case 'far-reid':
      if (allowed) rangeCounts.farReid++;
      else rangeCounts.tooFar++;
      break;
    case 'below-floor':
      rangeCounts.belowFloor++;
      break;
    case 'partial-body':
      rangeCounts.partialBody++;
      break;
    case 'edge-clipped':
      rangeCounts.edgeClipped++;
      break;
  }
}

export function rangeDiagnostics() {
  return { ...rangeCounts };
}

export function resetRangeDiagnostics() {
  for (const key of Object.keys(rangeCounts)) rangeCounts[key] = 0;
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

// Box proportions, deliberately *raw*: shapeSimilarity compares aspect ratios as a log ratio, so
// unlike every other feature here this one is not scale-invariant and must stay on its own scale
// on both sides of the comparison. See meanVector for the averaging path that keeps it that way.
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
// `appearance: false` skips the colour features and the MobileNet embedding - each one reads
// pixels back from the GPU, which is the costliest part of a check on a phone. Used when the
// re-identification embedding decides the match anyway (see Tracker.update).
export function extractSignature(source, box, embedder = null, timestamp = performance.now(), { appearance = true } = {}) {
  const { range, penalty } = matchRange(source, box);
  // `usable` keeps exactly the meaning it always had - the box passed boxQuality - and `range`
  // carries why it did not, so the far band can be let through without widening `usable` itself.
  const gates = { usable: range === 'ok', range, rangePenalty: penalty };
  if (!appearance) return { hist: [], lower: [], grid: [], shape: [], embed: [], ...gates };
  return {
    hist: appearanceHistogram(source, subBox(box, 0.16, 0.2, 0.68, 0.42)),
    lower: appearanceHistogram(source, subBox(box, 0.18, 0.58, 0.64, 0.34)),
    grid: bodyGrid(source, box),
    shape: shapeSignature(source, box),
    embed: personEmbedding(source, box, embedder, timestamp),
    ...gates,
  };
}

// Plain component-wise mean, on whatever scale the samples were on. Missing or non-finite
// components count as 0, and a short vector is padded, so one bad sample cannot shorten an entry.
function meanVector(vectors) {
  const len = Math.max(0, ...vectors.map((v) => v?.length ?? 0));
  const avg = new Array(len).fill(0);
  if (!len || !vectors.length) return avg;
  for (const vector of vectors) {
    for (let i = 0; i < len; i++) avg[i] += Number.isFinite(vector?.[i]) ? vector[i] : 0;
  }
  return avg.map((v) => v / vectors.length);
}

// ...and the same mean made a unit vector. For everything compared with cosine() the normalisation
// is free (cosine divides by the magnitudes anyway) and it keeps stored vectors on a uniform scale.
// `shape` is the one field it is *not* free for - see averageSignatures.
function averageVectors(vectors) {
  return normalize(meanVector(vectors));
}

// One gallery entry out of several samples of the same person at (roughly) the same angle.
// `shape` is averaged raw while everything else is normalised: shapeSimilarity compares aspect
// ratios through log(aspectA / aspectB), which is scale-*sensitive*, so an L2-normalised aspect is
// not an aspect ratio at all. It used to go through averageVectors with the rest, which divided
// every gallery aspect by its own vector's magnitude and left the live side raw - and because
// shapeSignature's second component is just the aspect times the frame's own aspect ratio, that
// divisor collapsed every enrolled person to the same constant (0.600 in a 4:3 frame). A standing
// person's live aspect of 2-3 against a gallery 0.600 is more than the log(2.2) tolerance, so
// `shape` scored 0 for the correct person, and both MIN_SHAPE_SCORE and EVIDENCE_MIN_PART were
// unreachable on every path that applies them - which is both model-free ones, since
// rejectionReason and evidenceWeight skip the per-part floors only for hasReid.
// See docs/shape-feature-bug.md.
export function averageSignatures(signatures) {
  return {
    hist: averageVectors(signatures.map((s) => s.hist)),
    lower: averageVectors(signatures.map((s) => s.lower)),
    grid: averageVectors(signatures.map((s) => s.grid)),
    shape: meanVector(signatures.map((s) => s.shape)),
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
//
// `reidScale` is the room-level decision from roomScoresOnReid(), and it is a parameter rather
// than something recomputed here because the choice is not per pair: see that function for why a
// single reid-less gallery has to put *everyone* on the blended path.
function similarityParts(a, b, reidScale = true) {
  const upper = cosine(a.hist, b.hist);
  const lower = cosine(a.lower, b.lower);
  const grid = cosine(a.grid, b.grid);
  const shape = shapeSimilarity(a.shape, b.shape);
  const embed = cosine(a.embed, b.embed);
  const hasEmbed = Boolean(a.embed?.length && b.embed?.length);
  // With a re-identification embedding on both sides, it alone decides: in evaluation, blending
  // in the colour features only made it worse (reid.js). The colour parts stay for debugging.
  const hasReid = reidScale && Boolean(a.reid?.length && b.reid?.length);
  const reid = hasReid ? cosine(a.reid, b.reid) : 0;
  // Carried through so the accept decision can still see it after smoothing replaced the score,
  // and only when there is one: a match from a box that passed the normal gate has no such field
  // at all, exactly as before.
  const rangePenalty = a.rangePenalty ?? 0;
  return {
    upper,
    lower,
    grid,
    shape,
    embed,
    reid,
    hasReid,
    ...(rangePenalty > 0 ? { rangePenalty } : null),
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
function bestAngleScore(signature, gallery, reidScale = true) {
  // A box in the far band is still refused by everything except re-identification, and there only
  // against reidScoreFloor()'s stricter bar. Dropping the match outright, rather than marking it
  // rejected, is what keeps the rest of the file out of this: a far box that cannot clear the bar
  // produces no ranking at all, which is byte for byte what it produced before - so evidence, soft
  // labels, the closed-set assignment and a latched name all carry on behaving as they did.
  const farReid = signature.rangePenalty > 0;
  if (signature.usable === false && !farReid) return null;
  const matches = [];
  for (let i = 0; i < gallery.length; i++) {
    const sample = gallery[i];
    if (!sample?.hist?.length || !sample?.grid?.length || !sample?.lower?.length || !sample?.shape?.length) continue;
    const parts = similarityParts(signature, sample, reidScale);
    if (farReid && !(parts.hasReid && parts.score >= reidScoreFloor(parts))) continue;
    matches.push({ ...parts, angleIndex: i });
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
    // reidScoreFloor() is the plain threshold unless the box was in the far band; it is applied
    // again here because smoothRankings replaces the score with a 3 s median, which can sit below
    // the raw check that bestAngleScore let through.
    if (best.score < reidScoreFloor(best)) return 'score';
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

// Whether this room can be scored on the re-identification scale at all: only when *every*
// enrolled player's gallery carries a reid vector.
//
// This has to be a property of the room, not of each (live, gallery-sample) pair, because the two
// scales are not comparable. A colour/embed cosine runs 0.95+ for the same person and 0.85-0.96
// for a different person in similar clothes; OSNet runs 0.70-0.85 for the correct person. Deciding
// per pair - which is what similarityParts used to do - means one player whose OSNet failed at
// enrolment is scored on the higher scale while everyone else is scored on the lower one, and
// decideRankings then sorts the two together as though they were the same quantity. The reid-less
// player becomes an attractor that outscores every correct re-identification match in the room
// (measured: a colour 0.963 beating the correct reid 0.800), and because `track.hasReid` is then
// false the colour accept path, the colour shot floor and the colour-only initial lock all apply
// to a name that is wrong.
//
// So a single reid-less gallery drops the whole room back to the blended path. That is strictly a
// loss of accuracy for the players who do have embeddings, and it is still the right trade: the
// blend is a weaker signal applied consistently, where the mix is a stronger signal applied
// incomparably. A gallery is all-or-nothing for `reid` (screens/scan.js enrols one or none), so
// the mix is always *across* players, never within one.
export function roomScoresOnReid(players) {
  return players.every((player) => !player.gallery?.length || player.gallery.some((s) => s.reid?.length));
}

// players: [{ id, name, gallery: [{hist, grid}, ...] }, ...]
// excludeId: the local player - never matched against their own gallery.
// reidScale: see roomScoresOnReid. Tracker.update passes the value it already computed for
// `reidDecides`, so the scale decision and the extraction skip cannot disagree; a caller that
// omits it gets the condition read off the players it passed.
export function matchGallery(
  signature,
  players,
  excludeId,
  { includeRejected = false, closedSet = false, reidScale = roomScoresOnReid(players) } = {},
) {
  const rankings = [];
  for (const player of players) {
    if ((!closedSet && player.id === excludeId) || !player.gallery?.length) continue;
    const match = bestAngleScore(signature, player.gallery, reidScale);
    if (!match) continue;
    rankings.push({ id: player.id, name: player.name, ...match });
  }
  return decideRankings(rankings, excludeId, { includeRejected, closedSet });
}

// The accept/reject decision on already scored rankings: shared by matchGallery and the
// tracker, which re-decides on its smoothed scores.
function decideRankings(rankings, excludeId, { includeRejected = false, closedSet = false } = {}) {
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
  if (!reason) return { ...best, accepted: true, candidates, rankings };
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

// Counts consecutive checks on which the re-identification score for the track's current player
// is clearly too low, and revokes the name once the *smoothed* score agrees that the player is
// gone.
//
// Two conditions, because the raw score and the median answer different questions and this used to
// read only the raw one. Acceptance, shootability and `track.score` are all the median over
// REID_HISTORY_MS (plus any motion adjustment) - the median exists precisely so that a side view
// or a motion-blurred check cannot unseat a player - while revocation counted raw checks and so
// overrode it. Three consecutive checks is 750-900 ms at RECHECK_MS, which is an ordinary side
// view, not "a different person stepped in": a player at 0.84-0.87 with a three-check burst at
// 0.55 was revoked outright, losing their name, their evidence and the whole reid history the
// median was built from, and then spending ~600 ms unidentified while it rebuilt from one sample.
// Under ?motion=on the two were further apart still, since acceptance saw median + motionAdjust
// and revocation saw neither.
//
// So the raw score stays as the fast *trigger* - it is what notices promptly, and nothing is
// revoked without it - and the median is the *authority*: the name goes only once the quantity
// that granted it has stopped clearing the bar that granted it (reidScoreFloor, which is also
// reidTargetMinScore, so the name and the shot are now lost on the same check rather than 1-2
// checks apart). The counter is not reset while the median still holds the player, so a real
// substitution is revoked on the first check the median concedes, not REID_REVOKE_CHECKS later.
//
// The cost is one check of latency on a genuine swap: a player at 0.95 replaced by someone at 0.30
// loses the name on the fourth bad check rather than the third. That check is also the first one on
// which the median drops under the shot floor, so the substitute was never shootable any earlier
// either - the extra latency is in the displayed name only.
function revokedByReid(track, match) {
  const current = (track.rankings?.length ? track.rankings : [match]).find((r) => r?.id === track.playerId);
  if (!current?.hasReid) return false;
  const raw = current.rawScore ?? current.score;
  track.reidMisses = raw < REID_REVOKE_SCORE ? (track.reidMisses ?? 0) + 1 : 0;
  if (track.reidMisses < REID_REVOKE_CHECKS) return false;
  // `current.score` is the median (smoothRankings) wherever there is a history to take one over.
  if (current.score >= reidScoreFloor(current)) return false;
  track.reidMisses = 0;
  return true;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Records this check's re-identification scores in the track's history and returns the rankings
// with each player's score replaced by its median over REID_HISTORY_MS (the latest stays in
// `rawScore`, for the debug overlay and revokedByReid), plus `scoreAdjust(track, playerId)`: the
// motion evidence for that player, kept in `motionAdjust`.
function smoothRankings(track, rankings, now, scoreAdjust) {
  track.reidHistory ??= new Map();
  for (const [id, list] of track.reidHistory) {
    while (list.length && list[0].t < now - REID_HISTORY_MS) list.shift();
    if (!list.length) track.reidHistory.delete(id);
  }
  return rankings.map((r) => {
    if (!r.hasReid) return r;
    const list = track.reidHistory.get(r.id) ?? [];
    list.push({ t: now, score: r.score });
    track.reidHistory.set(r.id, list);
    const motionAdjust = scoreAdjust?.(track, r.id) ?? 0;
    return { ...r, rawScore: r.score, motionAdjust, score: median(list.map((h) => h.score)) + motionAdjust };
  });
}

// Everything that made this track somebody, including the state that outlives a name: the
// accumulated evidence, the re-identification history the median is taken over, and the two miss
// counters. Those five used to be left behind, and two of the four callers compensated by clearing
// some of them by hand - so the two that did not got a track that was no longer anybody but still
// carried the baggage of who it had been:
//
//   - `reidMisses` survived, so a track cleared at 2 misses and later re-named was revoked again by
//     the *first* slightly-low check it saw, instead of getting its own REID_REVOKE_CHECKS.
//   - `evidence`/`evidenceDetails` survived, so a track cleared by duplicate resolution kept a full
//     bucket for the player it had just lost; evidenceWinner re-proposed that player on the next
//     check, duplicate resolution took it away again, and the track flip-flopped every two checks,
//     resetting identifiedAt - and so the shot lock - each time round.
//
// Clearing them here rather than at the call sites is what makes "this track has no identity" one
// statement instead of four, and `reidHistory` goes with them: a median carried over from the
// previous identity is a median of somebody else's scores.
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
  track.misses = 0;
  track.reidMisses = 0;
  // Optional-chained because a track handed in from an older frame (or built by hand in a test)
  // need not carry the maps yet.
  track.evidence?.clear();
  track.evidenceDetails?.clear();
  track.reidHistory?.clear();
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

// Whether one ranking is good enough on its own merits to be worth assigning to anybody.
//
// These are the same floors softLabelMatch applies - the point below which the per-track path
// will not even propose a candidate, let alone accept one - read per candidate rather than only
// for the winner, because the resolver ranks over every candidate of every track. For the
// re-identification path that is reidScoreFloor(), so a candidate scored through the far band
// still has to clear the stricter bar the band charges it (FAR_REID_MAX_PENALTY) rather than the
// plain threshold.
function resolverCandidateUsable(candidate) {
  if (candidate.hasReid) return candidate.score >= reidScoreFloor(candidate);
  return (
    candidate.score >= SOFT_LABEL_SCORE &&
    candidate.upper >= EVIDENCE_MIN_PART &&
    candidate.lower >= EVIDENCE_MIN_PART &&
    candidate.grid >= EVIDENCE_MIN_PART &&
    candidate.shape >= EVIDENCE_MIN_PART
  );
}

// A track whose own top two candidates are inside the accept margin is a tie, and a tie is not
// resolvable by picking one: which name lands on which person is decided by the sort, i.e.
// arbitrarily. decideRankings rejects it with reason 'margin' and softLabelMatch refuses to label
// it; the resolver has to refuse it too, or the documented guarantee holds only while one person
// is on screen.
function rankingsAreTied(rankings) {
  const [best, second] = rankings;
  if (!best || !second) return false;
  return best.score - second.score < (best.hasReid ? REID_MATCH_MARGIN : MATCH_MARGIN);
}

// With several people on screen at once, deciding each track on its own throws away the
// strongest hint available: the same player cannot be two of them. This assigns players to
// tracks greedily over all (track, candidate) pairs, nudged by stickiness to the current name,
// accumulated evidence, how clearly that candidate beat its rivals, and how many enrolled angles
// agreed.
//
// What it may assign is the whole question. Its only filter used to be `candidate.id === selfId`:
// it never consulted `accepted`, `reason`, reidMatchThreshold, REID_MATCH_MARGIN or any colour
// floor, so whenever two or more tracks were visible it overrode decideRankings, softLabelMatch,
// INITIAL_STREAK and SWITCH_STREAK wholesale and put a name on every visible track that had a pair
// available. Measured: a bystander at a re-identification cosine of 0.07, which matchGallery had
// refused with reason 'score', was named anyway; two people equidistant from two galleries were
// both named on check 0 - the 'margin' tie - and both shootable 150 ms later; and a look-alike took
// a dipping player's name, resetting identifiedAt and so the real player's shot lock.
//
// Three rules now bound it, and between them they leave the per-track path in charge of every
// decision it already makes:
//
//   1. Only candidates that clear resolverCandidateUsable() are even considered. The resolver
//      chooses *among* credible candidates; it does not manufacture one. A bystander whose best
//      score is 0.07 contributes no pairs at all.
//   2. A track holding a 'margin' tie contributes no pairs. Waiting is the documented behaviour.
//   3. It will not move a track off a name it already holds onto a *different* player. Changing an
//      identity is SWITCH_STREAK's job - four agreeing checks - and a greedy pass that reassigns on
//      one check is how a look-alike stole a name. The resolver may confirm the name a track holds,
//      or give a name to a track that has none.
//
// A track left unassigned keeps exactly what the per-track logic left it, latched name included.
// It used to be cleared, which was a fourth override: a named track whose check happened to
// produce no credible candidate - motion blur, a side view, half a body - lost its name outright,
// when the per-track path had deliberately decided to keep it (see the latch comment in update).
// The one case that still clears is the one the resolver exists for: this track holds a player that
// this resolution has just given to a better-supported track.
function resolveClosedSetIdentities(tracks, now, selfId) {
  const visible = tracks.filter((track) => track.lastSeen === now && !track.selfRejected && track.rankings?.length);
  if (visible.length < 2) return;

  const pairs = [];
  for (const track of visible) {
    if (rankingsAreTied(track.rankings)) continue;
    for (const candidate of track.rankings) {
      if (candidate.id === selfId) continue;
      if (track.playerId && candidate.id !== track.playerId) continue;
      if (!resolverCandidateUsable(candidate)) continue;
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
    if (usedTracks.has(track)) continue;
    if (track.playerId && usedPlayers.has(track.playerId)) clearIdentity(track);
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
    if (match.score < reidEvidenceMinScore()) return 0;
    return match.accepted ? EVIDENCE_WEIGHT_ACCEPTED : EVIDENCE_WEIGHT_SOFT + Math.max(0, match.score - reidEvidenceMinScore());
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
  if (match.hasReid) return match.score >= reidSoftLabelScore() ? { ...match, soft: true } : null;
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

// Fold one check into the leaky buckets - every candidate it scored, not just the winner.
//
// Recording only the best candidate made EVIDENCE_MARGIN unenforceable in the one situation it
// reads as guarding. With a *persistent* narrow leader the runner-up's bucket was never written
// at all, so it stayed 0, so `best.value - second` was the leader's whole bucket and the 0.12
// margin was passed trivially on every check: the guard only ever bit on rapid alternation
// between two candidates, never on the stable near-tie it describes. Writing a bucket per
// candidate is what makes the margin a margin.
//
// And a 'margin' rejection contributes nothing. softLabelMatch refuses to label a tie outright -
// "two players scoring the same is a tie, and guessing is worse than waiting" - but evidence was
// accumulated for the tied leader anyway, evidenceWinner handed the stored match back, and
// trackerCandidate consults the evidence winner *before* softLabelMatch. So the tie was named
// after all, two checks later, by the one route that had not been told about it: a permanent,
// perfectly balanced tie was named on check 2. The buckets rising together is not enough on its
// own to stop that - a near-tie inside REID_MATCH_MARGIN still diverges them slowly - so the
// refusal has to be explicit.
function addEvidence(track, match, selfId) {
  if (!match || match.reason === 'margin') return;
  const candidates = match.rankings?.length ? match.rankings : [match];
  for (const candidate of candidates) {
    // The local player is a candidate in closed-set mode - that is how the self-match guard sees
    // them - but they must never become a track's identity, and the 'self' rejection upstream only
    // fires when they are the *best* candidate. Banking evidence for them as a runner-up would let
    // the evidence path name a track as its own camera's owner once the real leader faded.
    if (candidate.id === selfId) continue;
    // `accepted` belongs to the decision, which is about the winner; a runner-up is at best a
    // soft near miss however good the winner was.
    const accepted = Boolean(match.accepted) && candidate.id === match.id;
    const scored = { ...candidate, accepted };
    const weight = evidenceWeight(scored);
    if (!weight) continue;
    track.evidence.set(candidate.id, (track.evidence.get(candidate.id) ?? 0) + weight);
    track.evidenceDetails.set(candidate.id, scored);
  }
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
    { includeRejected = false, embedder = null, reid = null, identifyOnce = false, closedSet = false, scoreAdjust = null } = {},
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

    // One condition, two consequences: it decides both whether the colour features are worth
    // extracting and - threaded into matchGallery below - which scale the room is scored on. They
    // used to be separate, and only the first was implemented: see roomScoresOnReid.
    const roomOnReid = roomScoresOnReid(players);
    const reidDecides = Boolean(reid) && roomOnReid;
    for (const track of this.tracks) {
      if (track.lastSeen !== now) continue; // not seen this frame, nothing to re-check
      const due =
        !track.playerId ||
        (!identifyOnce && (track.checks <= SETTLE_CHECKS || now - track.lastCheck >= RECHECK_MS));
      if (!due) continue;
      track.lastCheck = now;

      // When every enrolled player has re-identification embeddings, they alone decide (see
      // similarityParts), so the expensive colour features and MobileNet embedding are skipped.
      const signature = extractSignature(video, track.box, reidDecides ? null : embedder, now, { appearance: !reidDecides });
      if (reid) {
        // Re-identification runs in the background: use this track's latest embedding and ask
        // for a fresh one. Until its first embedding arrives, don't identify the track from
        // colours alone - that's how bystanders used to get labelled as players.
        signature.reid = reid.latest(track);
        // A box under the far floor can never be identified on any path, so a 128x256 OSNet
        // inference on it would be computed and then thrown away at bestAngleScore. It used to be
        // spent on every check of every too-small box in frame.
        if (signature.range !== 'below-floor') reid.request(track, video, track.box);
        if (!signature.reid) {
          countRange(signature, false);
          continue;
        }
      }
      const latest = matchGallery(signature, players, selfId, { includeRejected: true, closedSet, reidScale: roomOnReid });
      countRange(signature, Boolean(latest));
      // Keyed on there being rankings at all, not on the *best* candidate carrying re-id. The
      // best candidate's flag is the wrong key: whenever a non-reid candidate happened to top the
      // list, smoothRankings never ran, so the 3 s median was switched off for the whole track and
      // even its reid candidates were judged on a single raw check - which is precisely what
      // REID_DEFAULT_THRESHOLD was lowered to 0.65 on the assumption of. smoothRankings returns
      // non-reid rankings untouched, so running it unconditionally is safe on every path.
      const smoothed = () =>
        latest?.rankings
          ? decideRankings(smoothRankings(track, latest.rankings, now, scoreAdjust), selfId, { includeRejected: true, closedSet })
          : latest;
      let match = smoothed();
      track.rankings = match?.rankings ?? (match ? [match] : []);
      if (match?.reason === 'self' && match.id === selfId) {
        // The camera is looking at its own owner (a mirror, or a mis-scan). Drop the identity and
        // the evidence for it, but keep the rankings so the debug overlay can show what happened.
        const rankings = track.rankings;
        clearIdentity(track);
        track.rankings = rankings;
        track.debugMatch = match;
        track.selfRejected = true;
        continue;
      }
      track.selfRejected = false;
      if (track.playerId && track.hasReid && revokedByReid(track, match)) {
        // clearIdentity drops the evidence and the reid history too: that history belongs to the
        // person who left, so this track decides on this check alone.
        clearIdentity(track);
        match = smoothed();
        track.rankings = match?.rankings ?? (match ? [match] : []);
      }
      decayEvidence(track);
      addEvidence(track, match, selfId);
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
          candidateMatch.score >= (candidateMatch.hasReid ? reidInitialLock() : HIGH_CONFIDENCE_INITIAL_LOCK)
        ) {
          assignIdentity(track, candidateMatch);
        }
      }
      // A latched name keeps following its player's typical score, so the shot gate
      // (reidTargetMinScore) sees someone who has stopped looking like them.
      const current = track.hasReid && track.rankings.find((r) => r.id === track.playerId && r.hasReid);
      if (current) track.score = current.score;
    }
    if (closedSet) resolveClosedSetIdentities(this.tracks, now, selfId);
    resolveDuplicateIdentities(this.tracks, now);
    return this.tracks;
  }
}
