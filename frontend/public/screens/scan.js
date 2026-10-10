// Enrolment: recording what one player looks like, so that during the match other phones can
// tell *who* is under the crosshair instead of just seeing "a person".
//
// The player stands in full view and turns one slow circle while frames are recorded; afterwards
// every frame is scored for framing, light, contrast and sharpness, and only the best and most
// different-looking angles survive - near-duplicates and outliers are dropped, because a gallery
// of one pose matches everybody. The phone owner's own finished scan is cached in localStorage
// (scan-cache.js) so a reload does not mean rotating again.
//
// This is the heaviest path in the app, so processing is ordered cheapest-first and work that
// only the surviving samples need is deferred until selection has picked them:
//
//   per recorded frame  - the object detector (on a 512-wide copy), the quality gates, and the
//                         colour signature plus MobileNet embedding at full resolution. The pose
//                         landmarker only rescues frames the object detector found nobody in.
//   per chosen sample   - the OSNet re-identification embedding of each frame the sample was
//                         averaged from.
//
// Selection scores candidates on colour alone, so deferring re-identification does not change
// which samples are chosen or what ends up in them - see attachRotationSampleReid.
//
// It is also the path that holds the most memory, and the one place in the app where running out
// of it is *silent* rather than an error: a discarded canvas reads back as transparent black and
// describes beautifully. See the frame-lifecycle block further down.

import { DEBUG, canvas, ctx, video, $ } from '../env.js';
import { detectPeople, detectScanPeople } from '../detector.js';
import { extractSignature, scanBoxProblem } from '../identify.js';
import { keepScreenOn, pendingScanModels, whenScanModelsReady } from '../camera.js';
import {
  cacheableScan,
  degenerateSignature,
  scanCacheKey,
  staleScanCacheKeys,
  validScanCache,
  SCAN_CACHE_VERSION,
} from '../scan-cache.js';
import { attachSampleReid, reidSourceFrames } from '../scan-reid.js';
import { selectRotationSamples } from '../scan-select.js';
import { send } from '../net.js';
import { localSelfId } from '../roster.js';
import { state } from '../state.js';
import { showLobby } from './lobby.js';

const SCAN_MIN_SAMPLES = 12;
const SCAN_TARGET_SAMPLES = 24;
const SCAN_MIN_DETECTION_SCORE = 0.16;
const SCAN_MIN_BRIGHTNESS = 0.08;
const SCAN_MAX_BRIGHTNESS = 0.94;
const SCAN_MIN_CONTRAST = 0.025;
const SCAN_MIN_SHARPNESS = 0.0035;
const SCAN_DUPLICATE_SIMILARITY = 0.992;
const SCAN_OUTLIER_SIMILARITY = 0.36;
const SCAN_VIEW_AVERAGE_SIMILARITY = 0.74;
const SCAN_DIVERSITY_WEIGHT = 0.42;
const ROTATION_SCAN_COUNTDOWN_MS = 3_000;
const ROTATION_SCAN_DURATION_MS = 12_000;
const ROTATION_RECORD_FRAME_MS = 180;
const ROTATION_FRAME_MAX_WIDTH = 1024;
const ROTATION_SAMPLE_AVERAGE_COUNT = 4;
// Detection during processing only has to find *where* the body is, so it runs on a downscaled
// copy of the recorded frame - the same width gameplay detects at (GAME_DETECT_MAX_WIDTH in
// game.js). Every pixel that ends up in a signature is still read from the full-resolution frame.
const SCAN_DETECT_MAX_WIDTH = 512;
// Recorded frames handled between renderer yields. The loop has to stay cooperative so the
// progress counter moves and the ✕ stays responsive, but a yield costs a whole renderer frame,
// and the per-frame work is now small enough that yielding once per frame would dominate it.
const ROTATION_PROCESS_BATCH = 3;
// Side of the square a frame is scaled down to when checking it still has pixels (frameLost).
const FRAME_PROBE_SIZE = 8;

const ROTATION_SCAN_PROMPT = 'Stand where your whole body is visible and face the camera. When recording starts, slowly turn in one full circle.';

// ---- What a scan actually costs (?debug) ----
//
// Inference counts per model and wall-clock per phase, for the debug overlay. Scanning is the
// heaviest path in the app and the one the player waits on with nothing to look at, so "how many
// inferences and where did the seconds go" is worth being able to read off the screen rather than
// re-deriving from the constants - which is how the countdown and recording phases came to be
// described as costing nothing while the preview detection ran through both of them.
const scanCost = {
  frames: 0,
  usableFrames: 0,
  objectInferences: 0,
  poseInferences: 0,
  embedInferences: 0,
  reidInferences: 0,
  framePeakMb: 0,
  recordMs: 0,
  processMs: 0,
  selectMs: 0,
  reidMs: 0,
};

function resetScanCost() {
  for (const key of Object.keys(scanCost)) scanCost[key] = 0;
}

// One line for the debug overlay; empty until a scan has run on this page.
export function scanCostLine() {
  if (!scanCost.frames) return '';
  const ms = (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`);
  return (
    `Scan ${scanCost.usableFrames}/${scanCost.frames} usable · ` +
    `obj ${scanCost.objectInferences} pose ${scanCost.poseInferences} embed ${scanCost.embedInferences} ` +
    `reid ${scanCost.reidInferences} · peak ${scanCost.framePeakMb.toFixed(0)} MB of frames\n` +
    `  rec ${ms(scanCost.recordMs)} · proc ${ms(scanCost.processMs)} · sel ${ms(scanCost.selectMs)} · ` +
    `reid ${ms(scanCost.reidMs)}`
  );
}

// The scan screen has three states, all of them during a scan: waiting to start, rotating, and
// processing. There is no fourth. The branches this used to have for a part-built gallery ("N/24
// samples captured... keep rotating slowly") and a finished one ("returning to lobby") belonged to
// the retired incremental-capture flow and could not be reached: `state.gallery` is empty until
// runAutoScan sets it in one go at the very end, and every exit from a scan goes to the lobby -
// showLobby sets `state.mode = 'lobby'`, which is what the one remaining caller checks first.
function startScanStep() {
  const targetName = scanPersonName();
  if (state.postProcessingScan) {
    $('scan-instruction').textContent = `Processing ${targetName}'s rotation...`;
  } else {
    $('scan-instruction').textContent = `${targetName}: ${ROTATION_SCAN_PROMPT}`;
  }
}

function scanPersonName() {
  return state.scanTargetName || state.name;
}

export function loadScanCache() {
  const key = scanCacheKey(state.room);
  if (!key) return null;
  try {
    const cache = JSON.parse(localStorage.getItem(key));
    return validScanCache(cache, { room: state.room, minSamples: SCAN_MIN_SAMPLES, maxSamples: SCAN_TARGET_SAMPLES })
      ? cache
      : null;
  } catch {
    return null;
  }
}

// Caches the scan that has just finished, if it is this phone owner's own - see scan-cache.js for
// why a scan of anybody else is not cached at all, and why the slot is not addressed by name.
function saveScanCache(targetId) {
  const key = scanCacheKey(state.room);
  if (!key || !cacheableScan({ targetId, selfId: localSelfId() })) return;
  if (state.gallery.length < SCAN_MIN_SAMPLES) return;
  const cache = {
    version: SCAN_CACHE_VERSION,
    room: state.room,
    name: scanPersonName(), // for the debug overlay only; never an identity check - see rule 1
    savedAt: Date.now(),
    gallery: state.gallery,
  };
  try {
    // Dropped before the write, not after it: a quota the stale entries are filling is exactly
    // when the write would otherwise fail.
    for (const stale of staleScanCacheKeys(Object.keys(localStorage), key)) localStorage.removeItem(stale);
    localStorage.setItem(key, JSON.stringify(cache));
    state.savedScan = cache;
  } catch {
    // Remembering a scan across a reload is a convenience; the live scan still works without it.
  }
}

function setScanGallery(gallery) {
  state.gallery = gallery;
}

function afterNextPaint(callback) {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function showScanCountdown(seconds) {
  $('scan-screen').classList.add('countdown');
  $('scan-countdown').hidden = false;
  $('scan-countdown').textContent = String(seconds);
  $('scan-instruction').textContent =
    `${scanPersonName()}: stand fully visible and face the camera. Start turning slowly when recording begins.`;
}

export function hideScanCountdown() {
  $('scan-screen').classList.remove('countdown');
  $('scan-countdown').hidden = true;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function scanProblemMessage(problem) {
  if (problem === 'too-far') return 'step a little closer';
  if (problem === 'edge-clipped') return 'move fully inside the frame';
  if (problem === 'partial-body') return 'stand straighter or show more of your body';
  if (problem === 'low-confidence') return 'keep your body clearer in the camera';
  if (problem === 'low-light') return 'move into brighter light';
  if (problem === 'overexposed') return 'avoid strong backlight';
  if (problem === 'low-contrast') return 'use a less flat background or better light';
  if (problem === 'motion-blur') return 'turn a little slower';
  // 'no-person' is the only code that reaches here: a frame is only ever reported as a problem
  // when its problem is not 'ok', and the rest of the codes are above.
  return 'no person detected';
}

function sourceWidth(source) {
  return source.videoWidth || source.width || 1;
}

function sourceHeight(source) {
  return source.videoHeight || source.height || 1;
}

function boxScanQuality(box, source = video) {
  // sourceWidth/sourceHeight both end in `|| 1`, so only the box can be missing.
  if (!box) return 0;
  const sw = sourceWidth(source);
  const sh = sourceHeight(source);
  const area = (box.w * box.h) / (sw * sh);
  const height = box.h / sh;
  const cx = (box.x + box.w / 2) / sw;
  const cy = (box.y + box.h / 2) / sh;
  const centered = 1 - Math.min(1, Math.hypot(cx - 0.5, cy - 0.53) * 1.5);
  return area * 2 + height + centered * 0.5;
}

let scanStatsCanvas = null;
// Brightness, contrast and sharpness over the middle of the box - the same window bodyGrid reads
// (identify.js subBox(box, 0.08, 0.06, 0.84, 0.88)), measured in one read.
//
// The clipping below has to match readPixels in identify.js exactly, and did not: it subtracted
// nothing from the width when the window started left of the frame, so for a box overhanging the
// left or top edge the gate measured a window *shifted* inwards - wider, and over pixels the
// signature was never extracted from. The two only disagree for a clipped box tall enough to pass
// CLIPPED_OK_SCAN_HEIGHT_RATIO, which is a real scan: a player who fills the frame.
function scanImageStats(source, box) {
  scanStatsCanvas ??= document.createElement('canvas');
  const w = 32;
  const h = 48;
  scanStatsCanvas.width = w;
  scanStatsCanvas.height = h;
  const sample = scanStatsCanvas.getContext('2d', { willReadFrequently: true });
  const wx = box.x + box.w * 0.08;
  const wy = box.y + box.h * 0.06;
  const sx = Math.max(0, wx);
  const sy = Math.max(0, wy);
  const sw = Math.min(sourceWidth(source) - sx, box.w * 0.84 - (sx - wx));
  const sh = Math.min(sourceHeight(source) - sy, box.h * 0.88 - (sy - wy));
  if (sw <= 1 || sh <= 1) return { brightness: 0, contrast: 0, sharpness: 0 };

  sample.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  const px = sample.getImageData(0, 0, w, h).data;
  const luma = new Float32Array(w * h);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const y = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    luma[p] = y;
    sum += y;
    sumSq += y * y;
  }

  let diff = 0;
  let diffCount = 0;
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      diff += Math.abs(luma[i] - luma[i - 1]) + Math.abs(luma[i] - luma[i - w]);
      diffCount += 2;
    }
  }

  const n = luma.length || 1;
  const brightness = sum / n;
  return {
    brightness,
    contrast: Math.sqrt(Math.max(0, sumSq / n - brightness * brightness)),
    sharpness: diff / Math.max(1, diffCount),
  };
}

function assessScanCandidate(source, box) {
  const problem = scanBoxProblem(source, box);
  if (problem !== 'ok') return { problem, quality: boxScanQuality(box, source) };
  if ((box.score ?? 1) < SCAN_MIN_DETECTION_SCORE) return { problem: 'low-confidence', quality: 0 };

  const stats = scanImageStats(source, box);
  if (stats.brightness < SCAN_MIN_BRIGHTNESS) return { problem: 'low-light', quality: 0, stats };
  if (stats.brightness > SCAN_MAX_BRIGHTNESS) return { problem: 'overexposed', quality: 0, stats };
  if (stats.contrast < SCAN_MIN_CONTRAST) return { problem: 'low-contrast', quality: 0, stats };
  if (stats.sharpness < SCAN_MIN_SHARPNESS) return { problem: 'motion-blur', quality: 0, stats };

  return {
    problem: 'ok',
    stats,
    quality:
      boxScanQuality(box, source) +
      Math.min(box.score ?? 0.5, 1) * 0.25 +
      Math.min(stats.contrast * 2.2, 0.24) +
      Math.min(stats.sharpness * 7, 0.24),
  };
}

function bestScanBox(boxes, source = video) {
  return boxes.reduce((best, box) => (!best || boxScanQuality(box, source) > boxScanQuality(best, source) ? box : best), null);
}

function bestUsableScanCandidate(boxes, source = video) {
  let best = null;
  let fallback = null;
  for (const box of boxes) {
    const assessment = assessScanCandidate(source, box);
    const candidate = { box, ...assessment };
    if (!fallback || candidate.quality > fallback.quality) fallback = candidate;
    if (candidate.problem === 'ok' && (!best || candidate.quality > best.quality)) best = candidate;
  }
  return best ?? fallback ?? { problem: 'no-person', quality: 0, box: null };
}

function mostCommonProblem(problemCounts, fallback) {
  let best = fallback;
  let bestCount = 0;
  for (const [problem, count] of problemCounts) {
    if (count > bestCount) {
      best = problem;
      bestCount = count;
    }
  }
  return best;
}

function recordedFrameSize() {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.min(1, ROTATION_FRAME_MAX_WIDTH / vw);
  return { w: Math.max(1, Math.round(vw * scale)), h: Math.max(1, Math.round(vh * scale)) };
}

function captureRecordedFrame(time) {
  const { w, h } = recordedFrameSize();
  const image = document.createElement('canvas');
  image.width = w;
  image.height = h;
  image.getContext('2d').drawImage(video, 0, 0, w, h);
  return { image, time };
}

// ---- The frames, and how much of them is alive at once ----
//
// A recorded frame is a canvas, and a canvas is a backing store: 1024x576x4 B is 2.4 MB, and a
// 12 s rotation records about 60 of them. Holding all of them from the moment they are captured
// until the end of the OSNet pass - which is what the code used to do - is ~140 MB of live image
// data across the longest, busiest part of the scan. iOS Safari responds to that by discarding
// canvas backing stores, silently: `drawImage` from a discarded canvas paints *nothing*, so a
// frame that is still there as an object comes back as transparent black, and the scan carries on
// describing a blank rectangle. See frameLost for how that is caught now.
//
// So a frame is released the moment it has been described. The one thing that must survive
// selection is the pixels behind the chosen samples - that is the whole point of the
// select-then-embed design (scan-reid.js) - so each usable frame is replaced by a crop of just
// its person box before the full frame goes. The crop is what reid.js and nothing else reads, and
// it is the same region reid.js would have cropped out of the full frame anyway; everything that
// needs frame-relative geometry (shapeSignature, the quality gates) has already run by then.
const frameBytes = (image) => (image ? image.width * image.height * 4 : 0);

function releaseRecordedImage(image) {
  if (!image) return;
  // Not merely dropping the reference: resizing a canvas frees its backing store there and then,
  // rather than at the next GC, which on the phone where this matters is the difference.
  image.width = 1;
  image.height = 1;
}

// The person box, cropped out of the frame at full resolution, with the box rewritten into the
// crop's own coordinates. Clipped the way reid.js's snapshot clips, so the pixels it embeds are
// the pixels it would have embedded from the whole frame (resampled by at most the one sub-pixel
// the integer canvas size costs).
function cropFrameToBox(source, box) {
  const sx = Math.max(0, box.x);
  const sy = Math.max(0, box.y);
  const sw = Math.max(1, Math.min(box.w, sourceWidth(source) - sx));
  const sh = Math.max(1, Math.min(box.h, sourceHeight(source) - sy));
  const image = document.createElement('canvas');
  image.width = Math.max(1, Math.ceil(sw));
  image.height = Math.max(1, Math.ceil(sh));
  image.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, image.width, image.height);
  return { image, box: { ...box, x: 0, y: 0, w: image.width, h: image.height } };
}

let frameProbeCanvas = null;
// Whether this frame's pixels have gone. A recorded frame is drawn from an opaque video frame, so
// every pixel in a live one has alpha 255; a discarded backing store reads back as alpha 0
// everywhere. That makes alpha an exact test for "the browser took this frame away", with no false
// positive from a genuinely dark scan - which is why it is alpha and not brightness.
function frameLost(image) {
  if (!image || !image.width || !image.height) return true;
  frameProbeCanvas ??= document.createElement('canvas');
  frameProbeCanvas.width = FRAME_PROBE_SIZE;
  frameProbeCanvas.height = FRAME_PROBE_SIZE;
  const probe = frameProbeCanvas.getContext('2d', { willReadFrequently: true });
  probe.clearRect(0, 0, FRAME_PROBE_SIZE, FRAME_PROBE_SIZE);
  probe.drawImage(image, 0, 0, FRAME_PROBE_SIZE, FRAME_PROBE_SIZE);
  const { data } = probe.getImageData(0, 0, FRAME_PROBE_SIZE, FRAME_PROBE_SIZE);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

// Every crop still needed after selection: the frames backing the chosen samples, which is
// exactly what the embedding pass will read (reidSourceFrames), plus each sample's own seed frame.
// Everything else is released here rather than at the end of the scan, so the OSNet pass - the
// longest phase, and the one that runs under the most memory pressure - holds only what it uses.
function releaseUnchosenCandidates(candidates, samples) {
  const keep = new Set();
  for (const source of reidSourceFrames(samples).values()) keep.add(source.image);
  for (const sample of samples) keep.add(sample.image);
  for (const candidate of candidates) {
    if (!keep.has(candidate.image)) releaseRecordedImage(candidate.image);
  }
}

async function recordRotationVideo(live) {
  const frames = [];
  const startedAt = performance.now();
  const endsAt = startedAt + ROTATION_SCAN_DURATION_MS;

  // Suppresses the scan screen's preview detection for the duration (see the loop in game.js):
  // the player has been told to turn away from the phone, so the green box has nobody to inform,
  // and the main thread is wanted for the frame copies. The last countdown boxes go with it,
  // or drawScan would spend twelve seconds outlining where the player used to be standing.
  state.recordingScan = true;
  state.boxes = [];
  try {
    while (live() && performance.now() < endsAt) {
      await nextFrame();
      const now = performance.now();
      const remaining = Math.max(0, Math.ceil((endsAt - now) / 1000));
      frames.push(captureRecordedFrame(now - startedAt));
      $('scan-instruction').textContent = `Recording rotation... ${remaining}s left, ${frames.length} frames`;
      await wait(ROTATION_RECORD_FRAME_MS);
    }
  } finally {
    state.recordingScan = false;
  }

  if (live()) return frames;
  for (const frame of frames) releaseRecordedImage(frame.image);
  return null;
}

let scanDetectCanvas = null;
function scanDetectionSource(image) {
  const scale = Math.min(1, SCAN_DETECT_MAX_WIDTH / (image.width || 1));
  if (scale >= 0.99) return { source: image, scaleX: 1, scaleY: 1 };

  scanDetectCanvas ??= document.createElement('canvas');
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  if (scanDetectCanvas.width !== w || scanDetectCanvas.height !== h) {
    scanDetectCanvas.width = w;
    scanDetectCanvas.height = h;
  }
  scanDetectCanvas.getContext('2d').drawImage(image, 0, 0, w, h);
  return { source: scanDetectCanvas, scaleX: image.width / w, scaleY: image.height / h };
}

function scaleScanBoxes(boxes, scaleX, scaleY) {
  if (scaleX === 1 && scaleY === 1) return boxes;
  return boxes.map((box) => ({ ...box, x: box.x * scaleX, y: box.y * scaleY, w: box.w * scaleX, h: box.h * scaleY }));
}

// A scan is one cooperative subject who was asked to stand fully visible, so the object detector
// finds them on essentially every recorded frame. The pose landmarker costs about as much again,
// and detector.js only wants it here so that an unusual pose still gets a box - so it is kept as
// a per-frame rescue for the frames that come back empty rather than run on all of them. The
// rescue pays for a second object-detector pass (detector.js does not expose the pose boxes on
// their own), which is cheap when it only happens on the frames with nobody in them.
function detectRotationFrameBoxes(image) {
  const timestamp = rotationDetectTimestamp();
  const { source, scaleX, scaleY } = scanDetectionSource(image);
  const boxes = detectPeople(state.detector, source, timestamp);
  scanCost.objectInferences++;
  if (boxes.length) return scaleScanBoxes(boxes, scaleX, scaleY);
  // The rescue: a second object-detector pass plus the pose landmarker, only for a frame the
  // object detector found nobody in.
  scanCost.objectInferences++;
  if (state.poseDetector) scanCost.poseInferences++;
  return scaleScanBoxes(detectScanPeople(state.detector, state.poseDetector, source, timestamp + 1), scaleX, scaleY);
}

// The models run in VIDEO mode and reject a timestamp that does not advance, and the rescue pass
// above spends an extra millisecond of the budget. Processing a frame takes much longer than that
// in practice, but the clock is not what guarantees it, so step the stamp forward explicitly -
// the same guard identify.js's personEmbedding uses for the embedder.
let rotationDetectAt = 0;
function rotationDetectTimestamp() {
  rotationDetectAt = Math.max(rotationDetectAt + 2, Math.round(performance.now()));
  return rotationDetectAt;
}

// Re-identification embeddings for the samples that were actually chosen - the expensive half of
// enrolment, deferred until the cheap half has decided what it needs. scan-reid.js owns both the
// deferral and the batching, and explains why each is shaped the way it is; this is only the
// wiring to `state`, the progress line and the cancel flag.
async function attachRotationSampleReid(samples, live) {
  if (!state.reid) return true;
  scanCost.reidInferences = reidSourceFrames(samples).size;
  return attachSampleReid(samples, {
    // The last window in which a frame can be taken away, and the longest: these crops have been
    // alive since the processing loop and OSNet is the slowest thing in the app. A frame whose
    // pixels have gone embeds as a black rectangle - OSNet answers with a perfectly ordinary
    // unit vector for it, identical for every blank frame, which no later check could tell from a
    // real appearance. attachSampleReid turns a throw here into a failed scan with nothing written,
    // which is the only honest outcome.
    embed: (image, box) => {
      if (frameLost(image)) throw new Error('the browser discarded a recorded frame (out of memory)');
      return state.reid.embed(image, box);
    },
    yieldTo: nextFrame,
    cancelled: () => !live(),
    onProgress: (done, total) => {
      $('scan-instruction').textContent = `Recognising chosen angles... ${done}/${total} frames embedded`;
    },
  });
}

async function processRotationVideo(frames, live) {
  const candidates = [];
  const problemCounts = new Map();
  let lastProblem = 'no-person';
  state.postProcessingScan = true;
  scanCost.frames = frames.length;
  scanCost.framePeakMb = frames.reduce((bytes, frame) => bytes + frameBytes(frame.image), 0) / 1e6;
  const processStartedAt = performance.now();

  try {
    for (let i = 0; live() && i < frames.length; i++) {
      if (i % ROTATION_PROCESS_BATCH === 0) await nextFrame();
      if (!live()) break;
      const frame = frames[i];
      const boxes = detectRotationFrameBoxes(frame.image);
      // `problem === 'ok'` *is* usableScanBox: assessScanCandidate got it from scanBoxProblem,
      // which is the same boxQuality(..., MIN_SCAN_HEIGHT_RATIO, {scan: true}) call. Re-asking
      // used to repeat that per frame, and left the `?? scanBoxProblem(...)` fallback below dead.
      const candidate = bestUsableScanCandidate(boxes, frame.image);
      const box = candidate.box;

      if (box && candidate.problem === 'ok') {
        const signature = extractSignature(frame.image, box, state.embedder, performance.now());
        // Not `if (state.embedder)`: personEmbedding returns [] without inferring when there is
        // no embedder, no usable region, or the inference threw.
        if (signature.embed.length) scanCost.embedInferences++;
        // The frame passed the brightness gate a moment ago, so it had pixels then. An all-zero
        // vector now means they went away in between - the frame cannot be described, and a scan
        // that enrols it is worse than one that fails, because an all-zero vector scores 0
        // against everybody and the player simply stops matching.
        const blank = degenerateSignature(signature);
        if (blank) {
          throw new Error(
            `recorded frame ${i + 1}/${frames.length} came back blank (empty ${blank} vector) - the browser is out of memory`,
          );
        }
        const crop = cropFrameToBox(frame.image, box);
        candidates.push({
          signature,
          box: crop.box,
          image: crop.image,
          frameIndex: i,
          quality: candidate.quality,
          stats: candidate.stats,
          time: frame.time,
        });
      } else {
        lastProblem = candidate.problem;
        problemCounts.set(lastProblem, (problemCounts.get(lastProblem) ?? 0) + 1);
      }

      // Described, and now the only thing kept from it is its crop (or nothing).
      releaseRecordedImage(frame.image);
      frames[i] = { ...frame, image: null };

      $('scan-instruction').textContent =
        `Processing recorded rotation... ${i + 1}/${frames.length}, ${candidates.length} usable frames`;
    }

    if (!live()) return null;
    scanCost.usableFrames = candidates.length;
    scanCost.processMs = performance.now() - processStartedAt;

    const selectStartedAt = performance.now();
    // Selection yields to the renderer, so this is wall clock including those yields - which is
    // what the ✕ being responsive costs, and the number worth reading. Every threshold is passed
    // in so that the scan's tuning stays here (scan-select.js explains why).
    const samples = await selectRotationSamples(candidates, {
      targetCount: SCAN_TARGET_SAMPLES,
      minSamples: SCAN_MIN_SAMPLES,
      outlierSimilarity: SCAN_OUTLIER_SIMILARITY,
      duplicateSimilarity: SCAN_DUPLICATE_SIMILARITY,
      viewAverageSimilarity: SCAN_VIEW_AVERAGE_SIMILARITY,
      averageCount: ROTATION_SAMPLE_AVERAGE_COUNT,
      diversityWeight: SCAN_DIVERSITY_WEIGHT,
      yieldTo: nextFrame,
      cancelled: () => !live(),
    });
    scanCost.selectMs = performance.now() - selectStartedAt;
    if (!samples || !live()) return null;

    if (samples.length < SCAN_MIN_SAMPLES) {
      // A scan this short is never sent or cached, so it is not worth any re-identification work.
      return { problem: mostCommonProblem(problemCounts, lastProblem), samples, usableFrames: candidates.length, totalFrames: frames.length };
    }
    releaseUnchosenCandidates(candidates, samples);
    const reidStartedAt = performance.now();
    const attached = await attachRotationSampleReid(samples, live);
    scanCost.reidMs = performance.now() - reidStartedAt;
    if (!attached) return null;
    return { samples, usableFrames: candidates.length, totalFrames: frames.length };
  } finally {
    state.postProcessingScan = false;
    // Every path out of here is past the last thing that reads pixels: the embedding pass is
    // awaited above, and only `signature` leaves this function. So nothing is left alive for the
    // garbage collector to get round to in its own time - on a cancel or a throw either.
    for (const frame of frames) releaseRecordedImage(frame.image);
    for (const candidate of candidates) releaseRecordedImage(candidate.image);
  }
}

// Each run of a scan gets its own token, and every await inside it re-checks that the token is
// still the current one. `state.autoScanning` cannot do this job alone: it means "a scan is
// running", and both cancelScan() and beginPlayerScan() clear it - so a cancelled run parked on an
// await would see it set back to *true* by the next scan, pass its own liveness check, and carry on
// to completion under whoever is being scanned now. That ended with one player's gallery being sent
// under another player's id (and cached there), which mislabels them for the whole round. The
// window used to be the ~120 ms of a countdown tick; waiting for the optional models made it up to
// SCAN_MODEL_WAIT_MS, so the token is no longer optional.
let scanRun = 0;

async function runAutoScan() {
  if (state.autoScanning) return;
  const run = ++scanRun;
  // Captured now, not read at save time: the player being scanned can change under a stale run.
  const targetId = state.scanTargetId;
  // This run is still the live one, still wanted, and still on the scan screen.
  const live = () => run === scanRun && state.autoScanning && state.mode === 'scan';
  let finalMessage = null;
  state.autoScanning = true;
  state.gallery = [];
  resetScanCost();

  try {
    // The optional models keep loading behind the lobby rather than blocking it (startup.js), so
    // this is the one place that has to care whether they arrived. Enrolling without the embedder
    // or the recogniser does not fail - it quietly produces a *weaker* gallery, and that gallery
    // is then cached under SCAN_CACHE_VERSION and matched against by every phone for the rest of
    // the round, so the damage outlives the scan. Waiting here costs at most the tail of a
    // download the player has already been reading the lobby through, and it happens before the
    // countdown, so it never interrupts a rotation that has started.
    const pending = pendingScanModels();
    if (pending.length) {
      $('scan-instruction').textContent = `Finishing ${pending.join(' and ')} load...`;
      await whenScanModelsReady();
      if (!live()) return;
      startScanStep();
    }

    const readyAt = performance.now() + ROTATION_SCAN_COUNTDOWN_MS;
    while (live() && performance.now() < readyAt) {
      const seconds = Math.ceil((readyAt - performance.now()) / 1000);
      showScanCountdown(seconds);
      await wait(120);
    }
    if (!live()) return;
    hideScanCountdown();

    const recordStartedAt = performance.now();
    const frames = await recordRotationVideo(live);
    scanCost.recordMs = performance.now() - recordStartedAt;
    if (!live() || !frames) return;

    $('scan-instruction').textContent = `Recorded ${frames.length} frames. Processing usable angles...`;
    const result = await processRotationVideo(frames, live);
    if (!live() || !result) return;

    const signatures = result.samples.map((sample) => sample.signature);
    if (signatures.length >= SCAN_MIN_SAMPLES) {
      // The last gate before a gallery becomes this player's appearance for the rest of the round,
      // checked before `state.gallery` is touched. Nothing should be able to reach it - the
      // processing loop refuses a blank frame, and no average of describable frames is blank -
      // which is exactly why it throws rather than filters: if it ever fires, a scan that fails
      // loudly is the outcome worth having.
      assertEnrollableGallery(signatures);
    }
    setScanGallery(signatures);

    if (result.samples.length < SCAN_MIN_SAMPLES) {
      finalMessage =
        `Only got ${result.samples.length}/${SCAN_MIN_SAMPLES} usable angles from ${result.usableFrames}/${result.totalFrames} frames: ${scanProblemMessage(result.problem)}. Try again slower.`;
      return;
    }

    finalMessage = `Saved scan for ${scanPersonName()} with ${result.samples.length} angles.`;
    state.autoScanning = false;
    saveCurrentScan(targetId, finalMessage);
  } catch (err) {
    console.error(err);
    finalMessage = `Could not process the rotation video: ${err.message || err}`;
  } finally {
    // Only the live run owns the shared flags and the screen. A superseded run unwinding here
    // would otherwise cancel the scan that replaced it and overwrite its instruction text.
    if (run === scanRun) {
      state.autoScanning = false;
      state.recordingScan = false;
      hideScanCountdown();
      if (DEBUG && scanCost.frames) console.debug(scanCostLine());
      if (state.mode === 'scan') {
        startScanStep();
        if (finalMessage) showLobby(finalMessage);
      }
    }
  }
}

export function beginPlayerScan(player) {
  if (!player?.id) return;
  state.scanTargetId = player.id;
  state.scanTargetName = player.name || 'Player';
  state.savedScan = null;
  state.autoScanning = false;
  state.postProcessingScan = false;
  setScanGallery([]);
  // Before the screen appears, not when the next run starts: a scan cancelled during the countdown
  // never reaches runAutoScan's reset, and the ?debug overlay would then describe the scan before.
  resetScanCost();
  $('lobby-screen').hidden = true;
  $('game-screen').hidden = true;
  $('scan-screen').hidden = false;
  video.hidden = false;
  canvas.hidden = false;
  state.mode = 'scan';
  keepScreenOn();
  startScanStep();
  afterNextPaint(() => {
    if (state.mode === 'scan' && state.scanTargetId === player.id) runAutoScan();
  });
}

// recordRotationVideo/processRotationVideo/selectRotationSamples/attachRotationSampleReid are all
// handed runAutoScan's own `live()` and check it on every loop iteration, so they stop for a
// cancel *and* for being superseded - `state.autoScanning` alone cannot tell those apart (below),
// and a stale run that kept selecting would be burning the phone's one thread on a gallery its
// caller is going to discard. Their `finally` blocks notice state.mode is no longer 'scan' and
// skip touching the UI again. Every one of them returns null rather than a partial result, and
// runAutoScan only touches the gallery once it has a non-null result, so a cancel can never leave
// a half-built gallery behind.
//
// Clearing the flag is necessary but NOT sufficient, which is why cancelScan also retires the run
// token (see runAutoScan): the flag says "a scan is running", so the next scan setting it back to
// true would let a cancelled run that is parked on an await resume and finish under the new
// target. The flag handles stopping the work; the token handles whose work it is.
export function cancelScan() {
  scanRun++; // retire whatever is in flight: a parked run must not resume later
  state.autoScanning = false;
  state.recordingScan = false;
  state.postProcessingScan = false;
  showLobby('Scan cancelled.');
}

// The first required vector that is blank in any sample, as an exception. An all-zero vector is
// not a weak sample: cosine() scores it 0 against everything, so the player it was enrolled for
// stops matching entirely - and every check downstream accepts it, from validScanCache to the
// server's sanitiser. See scan-cache.js rule 2.
function assertEnrollableGallery(gallery) {
  for (const [i, signature] of gallery.entries()) {
    const blank = degenerateSignature(signature);
    if (blank) {
      throw new Error(`sample ${i + 1}/${gallery.length} has an empty or all-zero ${blank} vector`);
    }
  }
}

function saveCurrentScan(targetId, message = `Saved scan for ${scanPersonName()}.`) {
  if (!targetId || state.gallery.length < SCAN_MIN_SAMPLES) return;
  const gallery = state.gallery;
  const name = scanPersonName();
  if (targetId === localSelfId()) state.localGallery = gallery;
  const delivery = send({ type: 'scan', targetId, gallery });
  saveScanCache(targetId);
  showLobby(message);
  // "Saved scan for <name>" is the lobby's last word on a scan, and it used to be said whether or
  // not the gallery ever left the phone: a scan sent down a connection that had gone away was a
  // rotation the player was told had worked and that no other phone ever saw. `send` is
  // fire-and-forget here and returns a delivery promise on the branch that reworked the
  // connection, so take whichever it is and correct the lobby if it turns out not to have
  // arrived - only while the player is still looking at the lobby line that claimed it.
  Promise.resolve(delivery).then(
    (delivered) => {
      if (delivered === false) replaceLobbyMessage(`${name}'s scan could not be sent. Check the connection and rescan.`);
    },
    (err) => replaceLobbyMessage(`${name}'s scan could not be sent: ${err?.message || err}. Rescan to try again.`),
  );
}

// Corrects the lobby status line after the fact, and only if the player is still reading it.
function replaceLobbyMessage(message) {
  if (state.mode === 'lobby') $('lobby-status').textContent = message;
}

// Scan screen: just highlight whoever would be captured if "Capture" were tapped now.
export function drawScan({ toScreen }) {
  const target = bestScanBox(state.boxes, video);
  ctx.lineWidth = 3;
  for (const box of state.boxes) {
    ctx.strokeStyle = box === target ? '#39ff88' : 'rgba(255,255,255,0.4)';
    ctx.strokeRect(...toScreen(box));
  }
}
