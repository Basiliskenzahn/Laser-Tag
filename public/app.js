import { bodyBox, createDetector, detectScanPeople, detectTrackedPeople, detectTrackedPeopleFast, headBox, contains } from './detector.js';
import { averageSignatures, extractSignature, scanBoxProblem, Tracker, usableScanBox } from './identify.js';
import { createReid } from './reid.js';
import { openPolling } from './transport.js';
import * as sound from './sound.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const FIRE_COOLDOWN_MS = 350;
const LIVE_TRACK_MS = 520;
const SCAN_SAMPLE_COUNT = 6;
const SCAN_SAMPLE_INTERVAL_MS = 70;
const SCAN_CACHE_VERSION = 11; // 11: samples carry a re-identification embedding
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
const ROTATION_SCAN_COUNTDOWN_MS = 1800;
const ROTATION_SCAN_DURATION_MS = 12_000;
const ROTATION_RECORD_FRAME_MS = 180;
const ROTATION_FRAME_MAX_WIDTH = 1024;
const ROTATION_SAMPLE_AVERAGE_COUNT = 4;
const GAME_ACQUIRE_DETECT_INTERVAL_MS = 120;
const GAME_TRACK_DETECT_INTERVAL_MS = 180;
const GAME_POSE_DETECT_INTERVAL_MS = 520;
const SHOT_REFRESH_MAX_AGE_MS = 90;
const GAME_DETECT_MAX_WIDTH = 512;
const TARGET_LOCK_MS = 350;
const TARGET_MIN_SCORE = 0.48;
const TARGET_MIN_PART = 0.22;
// Re-identification identities can also come from accumulated evidence just under the accept
// threshold (0.72, identify.js); a shot needs at least this.
const TARGET_MIN_REID_SCORE = 0.7;

const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

const ROTATION_SCAN_PROMPT = 'Stand where your whole body is visible, then slowly turn in one full circle.';

const state = {
  name: '',
  room: '',
  conn: null, // connection to the game server (transport.js)
  myId: null,
  game: null, // latest state snapshot from the server (hp, status, ...)
  roster: [], // latest roster from the server (id, name, gallery)
  detector: null,
  poseDetector: null,
  embedder: null,
  reid: null, // person re-identification (reid.js); null if it couldn't load
  delegate: '',
  mode: 'scan', // 'scan' | 'game' - which screen the shared camera loop renders for
  boxes: [], // people in the latest camera frame, in video pixels
  tracker: new Tracker(),
  tracks: [],
  gallery: [], // signatures captured so far during enrolment
  scanThumbs: [], // data URLs matching gallery samples, used for the reusable debug cache
  savedScan: null,
  autoScanning: false,
  postProcessingScan: false,
  scanDone: false, // the join message (with the gallery) is only sent once scanning is finished
  events: null,
  failedConnects: 0, // connection attempts in a row that never opened
  lastShotAt: 0,
  lastGameDetectAt: 0,
  lastGamePoseDetectAt: 0,
  countdownEndsAt: null,
  lastCountdownBeep: null,
  bannerOverride: null,
};

// ---- Join screen ----

$('name').value = load('name') ?? '';
$('room').value = params.get('room') ?? load('room') ?? 'demo';

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.name = $('name').value.trim();
  state.room = $('room').value.trim().toLowerCase();
  state.savedScan = loadScanCache();
  save('name', state.name);
  save('room', state.room);

  // Everything that needs a user gesture happens here.
  sound.unlock();
  $('join-btn').disabled = true;
  setJoinStatus('Starting camera and loading the detector…');
  try {
    const loadReid = createReid().catch((err) => {
      // The colour + MobileNet signature still works without it, just less reliably.
      console.warn('Re-identification model unavailable', err);
      return null;
    });
    const [, { detector, poseDetector, embedder, delegate }, reid] = await Promise.all([startCamera(), createDetector(), loadReid]);
    state.detector = detector;
    state.poseDetector = poseDetector;
    state.embedder = embedder;
    state.reid = reid;
    state.delegate = `${delegate}${reid ? '+ReID' : ''}`;
  } catch (err) {
    console.error(err);
    setJoinStatus(startupErrorMessage(err));
    $('join-btn').disabled = false;
    return;
  }

  video.hidden = false;
  canvas.hidden = false;
  $('join-screen').hidden = true;
  $('scan-screen').hidden = false;
  $('debug').hidden = !DEBUG;
  keepScreenOn();
  renderSavedScan();
  startScanStep();
  requestAnimationFrame(loop);
  // Connect now rather than after scanning, so a server that can't be reached shows up
  // straight away instead of after the player has finished scanning.
  connect();
});

function setJoinStatus(text) {
  $('join-status').textContent = text;
}

function startupErrorMessage(err) {
  if (!window.isSecureContext) {
    return 'The camera only works over HTTPS. Open the https:// address the server printed.';
  }
  if (err.name === 'NotAllowedError') return 'Camera access was blocked. Allow it in your browser settings and try again.';
  if (err.name === 'NotFoundError') return 'No camera found on this device.';
  return `Could not start: ${err.message || err}`;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API not available');
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  await video.play();
}

async function keepScreenOn() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // Not supported or refused; the game still works.
  }
}
document.addEventListener('visibilitychange', () => {
  // The browser releases the wake lock whenever the page is hidden.
  if (document.visibilityState === 'visible' && state.detector) keepScreenOn();
});

// ---- Scan screen (enrolment) ----
//
// Before the match, each player is scanned from a few angles so later, during the match,
// other phones can tell *who* is under the crosshair rather than just seeing "a person".

function startScanStep() {
  const count = state.gallery.length;
  const ready = count >= SCAN_MIN_SAMPLES;
  const scanBusy = state.autoScanning || state.postProcessingScan;
  if (state.postProcessingScan) {
    $('scan-instruction').textContent = 'Processing recorded rotation...';
  } else if (state.autoScanning) {
    $('scan-instruction').textContent = ROTATION_SCAN_PROMPT;
  } else if (ready) {
    $('scan-instruction').textContent =
      count >= SCAN_TARGET_SAMPLES
        ? 'Rotation scan complete. Join when ready, or rescan to replace it.'
        : `${count}/${SCAN_TARGET_SAMPLES} samples captured. Join now or add more angles.`;
  } else if (count > 0) {
    $('scan-instruction').textContent =
      `${count}/${SCAN_TARGET_SAMPLES} samples captured. Keep rotating and add more angles.`;
  } else {
    $('scan-instruction').textContent =
      state.savedScan ? 'Use your saved scan, or rescan with a slow rotation.' : ROTATION_SCAN_PROMPT;
  }
  $('scan-capture-btn').hidden = count >= SCAN_TARGET_SAMPLES;
  $('scan-auto-btn').hidden = false;
  $('scan-join-btn').hidden = !ready || scanBusy;
  updateScanButtons();
  renderSavedScan();
}

function updateScanButtons() {
  $('scan-capture-btn').disabled = state.autoScanning || state.postProcessingScan || state.gallery.length >= SCAN_TARGET_SAMPLES;
}

function cropThumbnail(box, source = video) {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 64;
  c.getContext('2d').drawImage(source, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

function scanCacheKey() {
  return `scan:${state.room}:${state.name.toLowerCase()}`;
}

function validScanCache(cache) {
  return (
    cache?.version === SCAN_CACHE_VERSION &&
    cache.name === state.name &&
    cache.room === state.room &&
    Array.isArray(cache.gallery) &&
    cache.gallery.length >= SCAN_MIN_SAMPLES &&
    cache.gallery.length <= SCAN_TARGET_SAMPLES &&
    cache.gallery.every(
      (s) => Array.isArray(s?.hist) && Array.isArray(s?.lower) && Array.isArray(s?.grid) && Array.isArray(s?.shape),
    ) &&
    Array.isArray(cache.thumbs)
  );
}

function loadScanCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(`laser-tag:${scanCacheKey()}`));
    return validScanCache(cache) ? cache : null;
  } catch {
    return null;
  }
}

function saveScanCache() {
  if (state.gallery.length < SCAN_MIN_SAMPLES) return;
  try {
    const cache = {
      version: SCAN_CACHE_VERSION,
      name: state.name,
      room: state.room,
      savedAt: Date.now(),
      gallery: state.gallery,
      thumbs: state.scanThumbs,
    };
    localStorage.setItem(`laser-tag:${scanCacheKey()}`, JSON.stringify(cache));
    state.savedScan = cache;
    renderSavedScan();
  } catch {
    // The scan cache is only a debug convenience; the live scan still works.
  }
}

function clearScanCache() {
  try {
    localStorage.removeItem(`laser-tag:${scanCacheKey()}`);
  } catch {
    // Ignore storage errors; clearing the in-memory copy is enough for this run.
  }
  state.savedScan = null;
  state.autoScanning = false;
  state.postProcessingScan = false;
  state.gallery = [];
  state.scanThumbs = [];
  $('scan-thumbs').innerHTML = '';
  startScanStep();
}

function appendScanThumb(src) {
  const thumb = document.createElement('img');
  thumb.src = src;
  thumb.title = 'Tap to redo this and later angles';
  thumb.addEventListener('click', () => {
    const i = [...$('scan-thumbs').children].indexOf(thumb);
    state.gallery.length = i;
    state.scanThumbs.length = i;
    [...$('scan-thumbs').children].slice(i).forEach((el) => el.remove());
    startScanStep();
  });
  $('scan-thumbs').append(thumb);
}

function setScanGallery(gallery, thumbs) {
  state.gallery = gallery;
  state.scanThumbs = thumbs;
  $('scan-thumbs').innerHTML = '';
  for (const thumb of thumbs) appendScanThumb(thumb);
}

function renderSavedScan() {
  const readyToUse = Boolean(state.savedScan) && state.gallery.length === 0;
  $('saved-scan').hidden = !state.savedScan;
  $('use-saved-scan-btn').hidden = !readyToUse;
  $('clear-saved-scan-btn').textContent = readyToUse ? 'Rescan' : 'Clear saved scan';
}

function useSavedScan() {
  if (!state.savedScan) return;
  setScanGallery(state.savedScan.gallery, state.savedScan.thumbs ?? []);
  startScanStep();
}

function recordScanCapture(captured) {
  if (state.gallery.length >= SCAN_TARGET_SAMPLES) return;
  state.gallery.push(captured.signature);
  const thumb = cropThumbnail(captured.box);
  state.scanThumbs.push(thumb);
  appendScanThumb(thumb);
  startScanStep();
  saveScanCache();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function currentScanBoxes(timestamp = performance.now()) {
  const boxes = detectScanPeople(state.detector, state.poseDetector, video, timestamp);
  state.boxes = boxes;
  return boxes;
}

async function captureScanSignature() {
  const samples = [];
  let thumbnailBox = null;
  let problem = 'no-person';
  for (let i = 0; i < SCAN_SAMPLE_COUNT; i++) {
    await nextFrame();
    const now = performance.now();
    const candidate = bestUsableScanCandidate(currentScanBoxes(now), video);
    const box = candidate.box;
    if (box && candidate.problem === 'ok' && usableScanBox(video, box)) {
      const signature = extractSignature(video, box, state.embedder, now);
      if (state.reid) signature.reid = await state.reid.embed(video, box);
      samples.push(signature);
      thumbnailBox = box;
      problem = 'ok';
    } else {
      problem = candidate.problem ?? scanBoxProblem(video, box);
    }
    if (i < SCAN_SAMPLE_COUNT - 1) await wait(SCAN_SAMPLE_INTERVAL_MS);
  }
  return samples.length >= Math.ceil(SCAN_SAMPLE_COUNT / 2)
    ? { signature: averageSignatures(samples), box: thumbnailBox }
    : { problem };
}

function scanProblemMessage(problem) {
  if (problem === 'too-far') return 'step a little closer';
  if (problem === 'edge-clipped') return 'move fully inside the frame';
  if (problem === 'partial-body') return 'stand straighter or show more of your body';
  if (problem === 'low-confidence') return 'keep your body clearer in the camera';
  if (problem === 'low-light') return 'move into brighter light';
  if (problem === 'overexposed') return 'avoid strong backlight';
  if (problem === 'low-contrast') return 'use a less flat background or better light';
  if (problem === 'motion-blur') return 'turn a little slower';
  return 'no person detected';
}

function sourceWidth(source) {
  return source.videoWidth || source.width || 1;
}

function sourceHeight(source) {
  return source.videoHeight || source.height || 1;
}

function boxScanQuality(box, source = video) {
  if (!sourceWidth(source) || !sourceHeight(source) || !box) return 0;
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
function scanImageStats(source, box) {
  scanStatsCanvas ??= document.createElement('canvas');
  const w = 32;
  const h = 48;
  scanStatsCanvas.width = w;
  scanStatsCanvas.height = h;
  const sample = scanStatsCanvas.getContext('2d', { willReadFrequently: true });
  const sx = Math.max(0, box.x + box.w * 0.08);
  const sy = Math.max(0, box.y + box.h * 0.06);
  const sw = Math.min(sourceWidth(source) - sx, box.w * 0.84);
  const sh = Math.min(sourceHeight(source) - sy, box.h * 0.88);
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

function removeScanOutliers(candidates) {
  if (candidates.length <= SCAN_MIN_SAMPLES) return candidates;
  const scored = candidates.map((candidate) => {
    const neighbors = candidates
      .filter((other) => other !== candidate)
      .map((other) => signatureSimilarity(candidate.signature, other.signature))
      .sort((a, b) => b - a)
      .slice(0, 4);
    const neighborScore = neighbors.reduce((sum, value) => sum + value, 0) / Math.max(1, neighbors.length);
    return { ...candidate, neighborScore };
  });
  const kept = scored.filter((candidate) => candidate.neighborScore >= SCAN_OUTLIER_SIMILARITY);
  return kept.length >= SCAN_MIN_SAMPLES ? kept : scored.sort((a, b) => b.quality - a.quality).slice(0, SCAN_MIN_SAMPLES);
}

function removeScanDuplicates(candidates) {
  const kept = [];
  for (const candidate of [...candidates].sort((a, b) => b.quality - a.quality)) {
    if (kept.every((sample) => signatureSimilarity(candidate.signature, sample.signature) < SCAN_DUPLICATE_SIMILARITY)) {
      kept.push(candidate);
    }
  }
  return kept.length >= SCAN_MIN_SAMPLES ? kept : candidates;
}

function averagedRotationSample(seed, candidates) {
  const neighbors = candidates
    .map((candidate) => ({ candidate, similarity: candidate === seed ? 1 : signatureSimilarity(seed.signature, candidate.signature) }))
    .filter((entry) => entry.candidate === seed || entry.similarity >= SCAN_VIEW_AVERAGE_SIMILARITY)
    .sort((a, b) => b.similarity + b.candidate.quality * 0.05 - (a.similarity + a.candidate.quality * 0.05))
    .slice(0, ROTATION_SAMPLE_AVERAGE_COUNT)
    .map((entry) => entry.candidate);
  return {
    ...seed,
    signature: averageSignatures(neighbors.map((candidate) => candidate.signature)),
    quality: neighbors.reduce((sum, candidate) => sum + candidate.quality, 0) / neighbors.length,
    sourceCount: neighbors.length,
  };
}

function selectDiverseRotationSeeds(candidates, targetCount) {
  const pool = [...candidates].sort((a, b) => b.quality - a.quality);
  const selected = [];
  while (pool.length && selected.length < targetCount) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      const nearest = selected.length
        ? Math.max(...selected.map((sample) => signatureSimilarity(candidate.signature, sample.signature)))
        : 0;
      const score = candidate.quality + (1 - nearest) * SCAN_DIVERSITY_WEIGHT;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function orderRotationSamplesByView(samples) {
  if (samples.length < 3) return samples.sort((a, b) => a.time - b.time);
  const remaining = [...samples];
  const ordered = [remaining.splice(remaining.findIndex((sample) => sample.quality === Math.max(...remaining.map((s) => s.quality))), 1)[0]];
  while (remaining.length) {
    const last = ordered.at(-1);
    let bestIndex = 0;
    let bestSimilarity = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const similarity = signatureSimilarity(last.signature, remaining[i].signature);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = i;
      }
    }
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  return ordered;
}

function selectRotationSamples(candidates, targetCount) {
  const clean = removeScanDuplicates(removeScanOutliers(candidates));
  if (clean.length <= targetCount) return orderRotationSamplesByView(clean);
  const seeds = selectDiverseRotationSeeds(clean, targetCount);
  return orderRotationSamplesByView(seeds.map((seed) => averagedRotationSample(seed, clean))).slice(0, targetCount);
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

let gameInferenceCanvas = null;
function gameplayInferenceSource() {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.min(1, GAME_DETECT_MAX_WIDTH / vw);
  if (scale >= 0.99) return { source: video, scaleX: 1, scaleY: 1 };

  gameInferenceCanvas ??= document.createElement('canvas');
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  if (gameInferenceCanvas.width !== w || gameInferenceCanvas.height !== h) {
    gameInferenceCanvas.width = w;
    gameInferenceCanvas.height = h;
  }
  gameInferenceCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return { source: gameInferenceCanvas, scaleX: vw / w, scaleY: vh / h };
}

function scaleBoxes(boxes, scaleX, scaleY) {
  if (scaleX === 1 && scaleY === 1) return boxes;
  return boxes.map((box) => ({
    ...box,
    x: box.x * scaleX,
    y: box.y * scaleY,
    w: box.w * scaleX,
    h: box.h * scaleY,
  }));
}

function gameDetectInterval(now) {
  const liveTracks = state.tracks.filter((track) => isLiveTrack(track, now));
  return liveTracks.length && liveTracks.every((track) => track.playerId)
    ? GAME_TRACK_DETECT_INTERVAL_MS
    : GAME_ACQUIRE_DETECT_INTERVAL_MS;
}

function rosterCandidateCount() {
  const ids = new Set();
  for (const player of state.roster) {
    if (player.gallery?.length) ids.add(player.id);
  }
  if (state.gallery.length) ids.add(localSelfId());
  return ids.size;
}

function shouldUsePoseFallback(now, forcePose = false) {
  if (!state.poseDetector) return false;
  if (forcePose) return true;
  if (rosterCandidateCount() < 2) return false;
  return now - state.lastGamePoseDetectAt >= GAME_POSE_DETECT_INTERVAL_MS;
}

function detectGameplayPeople(source, timestamp, { forcePose = false } = {}) {
  if (shouldUsePoseFallback(timestamp, forcePose)) {
    state.lastGamePoseDetectAt = timestamp;
    return detectTrackedPeople(state.detector, state.poseDetector, source, timestamp);
  }
  return detectTrackedPeopleFast(state.detector, source, timestamp);
}

function refreshGameDetection({ forcePose = false } = {}) {
  if (state.mode !== 'game' || video.readyState < 2) return false;
  const t0 = performance.now();
  const { source, scaleX, scaleY } = gameplayInferenceSource();
  state.boxes = scaleBoxes(detectGameplayPeople(source, t0, { forcePose }), scaleX, scaleY);
  state.tracks = state.tracker.update(state.boxes, video, matchingRoster(), localSelfId(), t0, {
    includeRejected: DEBUG,
    identifyOnce: false,
    embedder: state.embedder,
    reid: state.reid,
    closedSet: true,
  });
  state.lastGameDetectAt = t0;
  inferenceMs = performance.now() - t0;
  frames++;
  return true;
}

async function recordRotationVideo() {
  const frames = [];
  const startedAt = performance.now();
  const endsAt = startedAt + ROTATION_SCAN_DURATION_MS;

  while (state.autoScanning && performance.now() < endsAt) {
    await nextFrame();
    const now = performance.now();
    const remaining = Math.max(0, Math.ceil((endsAt - now) / 1000));
    frames.push(captureRecordedFrame(now - startedAt));
    $('scan-instruction').textContent = `Recording rotation... ${remaining}s left, ${frames.length} frames`;
    await wait(ROTATION_RECORD_FRAME_MS);
  }

  return state.autoScanning ? frames : null;
}

async function processRotationVideo(frames) {
  const candidates = [];
  const problemCounts = new Map();
  let lastProblem = 'no-person';
  state.postProcessingScan = true;
  updateScanButtons();

  try {
    for (let i = 0; state.autoScanning && i < frames.length; i++) {
      await nextFrame();
      const frame = frames[i];
      const boxes = detectScanPeople(state.detector, state.poseDetector, frame.image, performance.now());
      const candidate = bestUsableScanCandidate(boxes, frame.image);
      const box = candidate.box;

      if (box && candidate.problem === 'ok' && usableScanBox(frame.image, box)) {
        const signature = extractSignature(frame.image, box, state.embedder, performance.now());
        if (state.reid) signature.reid = await state.reid.embed(frame.image, box);
        candidates.push({
          signature,
          box: { ...box },
          thumb: cropThumbnail(box, frame.image),
          quality: candidate.quality,
          stats: candidate.stats,
          time: frame.time,
        });
      } else {
        lastProblem = candidate.problem ?? scanBoxProblem(frame.image, box);
        problemCounts.set(lastProblem, (problemCounts.get(lastProblem) ?? 0) + 1);
      }

      $('scan-instruction').textContent =
        `Processing recorded rotation... ${i + 1}/${frames.length}, ${candidates.length} usable frames`;
    }
  } finally {
    state.postProcessingScan = false;
    updateScanButtons();
  }

  if (!state.autoScanning) return null;
  const samples = selectRotationSamples(candidates, SCAN_TARGET_SAMPLES);
  if (samples.length < SCAN_MIN_SAMPLES) {
    return { problem: mostCommonProblem(problemCounts, lastProblem), samples, usableFrames: candidates.length, totalFrames: frames.length };
  }
  return { samples, usableFrames: candidates.length, totalFrames: frames.length };
}

$('scan-capture-btn').addEventListener('click', async () => {
  const step = state.gallery.length;
  $('scan-capture-btn').disabled = true;
  $('scan-instruction').textContent = 'Capturing this angle...';
  const captured = await captureScanSignature();
  $('scan-capture-btn').disabled = false;
  if (state.gallery.length !== step) return;
  if (!captured.signature) {
    $('scan-instruction').textContent = `${ROTATION_SCAN_PROMPT} (${scanProblemMessage(captured.problem)})`;
    return;
  }
  recordScanCapture(captured);
});

async function runAutoScan() {
  if (state.autoScanning) return;
  let finalMessage = null;
  state.autoScanning = true;
  state.gallery = [];
  state.scanThumbs = [];
  $('scan-thumbs').innerHTML = '';
  updateScanButtons();
  $('scan-auto-btn').textContent = 'Stop';

  try {
    const readyAt = performance.now() + ROTATION_SCAN_COUNTDOWN_MS;
    while (state.autoScanning && performance.now() < readyAt) {
      const seconds = Math.ceil((readyAt - performance.now()) / 1000);
      $('scan-instruction').textContent = `${ROTATION_SCAN_PROMPT} Starting in ${seconds}...`;
      await wait(120);
    }
    if (!state.autoScanning) return;

    const frames = await recordRotationVideo();
    if (!state.autoScanning || !frames) return;

    $('scan-instruction').textContent = `Recorded ${frames.length} frames. Processing usable angles...`;
    const result = await processRotationVideo(frames);
    if (!state.autoScanning || !result) return;

    const signatures = result.samples.map((sample) => sample.signature);
    const thumbs = result.samples.map((sample) => sample.thumb);
    setScanGallery(signatures, thumbs);

    if (result.samples.length < SCAN_MIN_SAMPLES) {
      finalMessage =
        `Only got ${result.samples.length}/${SCAN_MIN_SAMPLES} usable angles from ${result.usableFrames}/${result.totalFrames} frames: ${scanProblemMessage(result.problem)}. Try again slower.`;
      return;
    }

    saveScanCache();
    finalMessage = `Saved ${result.samples.length} angles from ${result.usableFrames} usable rotation frames.`;
  } catch (err) {
    console.error(err);
    finalMessage = `Could not process the rotation video: ${err.message || err}`;
  } finally {
    state.autoScanning = false;
    $('scan-auto-btn').textContent = 'Scan rotation';
    updateScanButtons();
    startScanStep();
    if (finalMessage) $('scan-instruction').textContent = finalMessage;
  }
}

$('use-saved-scan-btn').addEventListener('click', useSavedScan);
$('clear-saved-scan-btn').addEventListener('click', clearScanCache);
$('scan-auto-btn').addEventListener('click', () => {
  if (state.autoScanning) state.autoScanning = false;
  else runAutoScan();
});

$('scan-join-btn').addEventListener('click', () => {
  $('scan-screen').hidden = true;
  $('game-screen').hidden = false;
  state.mode = 'game';
  state.scanDone = true;
  sendJoin(); // if the connection isn't open yet, onOpen sends it
  openGameEvents();
  renderHud();
});

// ---- Networking ----

const UNREACHABLE_MESSAGE = "Can't connect to the game server. Check your internet connection. Still retrying…";

// Game control/state messages use HTTP polling. Health/death notifications use SSE once the
// player enters the game screen.
function connect() {
  let opened = false;
  const conn = openPolling({
    onOpen() {
      opened = true;
      state.failedConnects = 0;
      showConnectionProblem(null);
      sendJoin();
    },
    onMessage: handleMessage,
    onClose() {
      if (state.conn !== conn) return;
      state.game = null;
      if (!opened) state.failedConnects++;
      showConnectionProblem(state.failedConnects >= 2 ? UNREACHABLE_MESSAGE : 'Connection lost. Reconnecting…');
      setTimeout(connect, 1500);
    },
  });
  state.conn = conn;
}

function sendJoin() {
  if (state.scanDone) send({ type: 'join', name: state.name, room: state.room, gallery: state.gallery, debug: DEBUG });
}

function matchingRoster() {
  const selfId = localSelfId();
  const roster = state.roster.filter((player) => player.id !== selfId);
  if (!state.gallery.length) return roster;
  const self = { id: selfId, name: 'Person', gallery: state.gallery };
  return [...roster, self];
}

function localSelfId() {
  return state.myId ?? '__local-self';
}

// Connection problems go on whichever screen is showing: the scan panel or the game banner.
function showConnectionProblem(text) {
  $('scan-connection').textContent = text ?? '';
  $('scan-connection').hidden = !text || state.mode !== 'scan';
  state.bannerOverride = text;
  renderHud();
}

function send(msg) {
  state.conn?.send(msg);
}

function openGameEvents() {
  state.events?.close();
  const room = encodeURIComponent(state.room);
  const events = new EventSource(`/events/${room}`);
  events.onmessage = handleGameEvent;
  events.addEventListener('health', (event) => handleGameEvent(event));
  events.addEventListener('death', (event) => handleGameEvent(event));
  events.onerror = () => {
    // EventSource reconnects automatically; no UI noise needed during play.
  };
  state.events = events;
}

function handleGameEvent(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }
  if (DEBUG && (msg.type === 'health' || msg.type === 'death')) {
    console.debug('game event', msg);
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      state.myId = msg.id;
      state.bannerOverride = null;
      break;
    case 'error':
      state.bannerOverride = msg.message;
      renderHud();
      break;
    case 'roster':
      state.roster = msg.players;
      break;
    case 'state':
      onState(msg.state);
      break;
    case 'hitConfirmed':
      sound.hitConfirmed(msg.zone === 'head');
      restartAnimation($('crosshair'), 'hit');
      popup(msg.zone === 'head' ? `HEADSHOT −${msg.damage}` : `−${msg.damage}`, msg.zone === 'head');
      break;
    case 'gotHit':
      sound.hurt();
      navigator.vibrate?.(msg.zone === 'head' ? [80, 40, 160] : 120);
      restartAnimation($('damage'), 'flash');
      break;
  }
}

function onState(game) {
  const previous = state.game;
  state.game = game;
  // Keep the countdown running into "playing" so "GO!" stays up briefly; updateCountdown clears it.
  if (game.status === 'countdown') state.countdownEndsAt = performance.now() + game.startsInMs;
  else if (game.status !== 'playing') state.countdownEndsAt = null;
  if (game.status === 'over' && previous?.status !== 'over') {
    game.winner === state.myId ? sound.win() : sound.lose();
  }
  renderHud();
}

// ---- HUD ----

function renderHud() {
  const game = state.game;
  const hud = $('hud');
  hud.innerHTML = '';
  for (const p of game?.players ?? []) {
    const row = document.createElement('div');
    row.className = `player${p.id === state.myId ? ' me' : ''}${!p.alive ? ' down' : ''}`;
    row.innerHTML = `
      <div class="label"><span>${escapeHtml(p.name)}${p.id === state.myId ? ' (you)' : ''}</span>${p.wins ? `<span class="wins">★${p.wins}</span>` : ''}</div>
      <div class="hp"><div class="hp-fill${p.hp / game.maxHp <= 0.3 ? ' low' : ''}" style="width:${(p.hp / game.maxHp) * 100}%"></div></div>`;
    hud.append(row);
  }

  const startBtn = $('start-btn');
  const canStart = game && (game.status === 'waiting' || game.status === 'over') && game.players.length >= game.minPlayers;
  startBtn.hidden = !game || (game.status !== 'waiting' && game.status !== 'over');
  startBtn.disabled = !canStart;
  startBtn.textContent = game?.status === 'over' ? 'Play again' : 'Start game';

  const text = $('banner-text');
  const me = game?.players.find((p) => p.id === state.myId);
  const winner = game?.players.find((p) => p.id === game.winner);
  text.classList.remove('big');
  if (state.bannerOverride) text.textContent = state.bannerOverride;
  else if (!game) text.textContent = 'Connecting…';
  else if (game.status === 'waiting') {
    text.textContent =
      game.players.length < game.minPlayers
        ? `Waiting for more players… Room code: ${game.code} (${game.players.length}/${game.minPlayers})`
        : `Ready - room code: ${game.code}`;
  } else if (game.status === 'over') {
    text.textContent = game.winner === state.myId ? 'You win!' : `${winner?.name ?? 'Someone'} wins!`;
  } else if (game.status === 'playing' && me && !me.alive) {
    text.textContent = 'You are down';
  } else {
    text.textContent = ''; // countdown is drawn every frame in loop()
  }

  const fireBtn = $('fire-btn');
  const canFire = canLocalPlayerFire();
  fireBtn.hidden = !canFire;
  fireBtn.disabled = !canFire;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateCountdown() {
  if (state.countdownEndsAt === null) return;
  const text = $('banner-text');
  const remaining = state.countdownEndsAt - performance.now();
  const n = Math.ceil(remaining / 1000);
  const label = n > 0 ? String(n) : 'GO!';
  if (label !== state.lastCountdownBeep) {
    state.lastCountdownBeep = label;
    sound.countdownBeep(n <= 0);
  }
  text.classList.add('big');
  text.textContent = label;
  if (remaining < -700) {
    // The server's "playing" update clears the countdown; this just hides "GO!".
    state.countdownEndsAt = null;
    state.lastCountdownBeep = null;
    renderHud();
  }
}

function popup(text, headshot) {
  const el = document.createElement('div');
  el.className = `popup${headshot ? ' headshot' : ''}`;
  el.textContent = text;
  $('popups').append(el);
  el.addEventListener('animationend', () => el.remove());
}

function restartAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // force a reflow so the animation plays again
  el.classList.add(className);
}

$('start-btn').addEventListener('click', () => send({ type: 'start' }));

// ---- Shooting ----

function isLiveTrack(track, now = performance.now()) {
  return now - track.lastSeen <= LIVE_TRACK_MS;
}

function gamePlayer(playerId) {
  return state.game?.players.find((player) => player.id === playerId) ?? null;
}

function isAlivePlayer(playerId) {
  return gamePlayer(playerId)?.alive === true;
}

function isDeadPlayer(playerId) {
  return gamePlayer(playerId)?.alive === false;
}

function canLocalPlayerFire() {
  return state.mode === 'game' && state.game?.status === 'playing' && isAlivePlayer(localSelfId());
}

function isStableTarget(track, now = performance.now()) {
  // A re-identification match has already cleared its own threshold; the colour-part minimums
  // below are for the colour signature, and lighting can push them down for the right person.
  if (track.hasReid) {
    return Boolean(
      track.playerId &&
        Number.isFinite(track.identifiedAt) &&
        now - track.identifiedAt >= TARGET_LOCK_MS &&
        track.score >= TARGET_MIN_REID_SCORE,
    );
  }
  return Boolean(
    track.playerId &&
      Number.isFinite(track.identifiedAt) &&
      now - track.identifiedAt >= TARGET_LOCK_MS &&
      track.score >= TARGET_MIN_SCORE &&
      track.upper >= TARGET_MIN_PART &&
      track.lower >= TARGET_MIN_PART &&
      track.grid >= TARGET_MIN_PART,
  );
}

function isTargetableTrack(track, now = performance.now()) {
  return state.game?.status === 'playing' && isStableTarget(track, now) && isAlivePlayer(track.playerId);
}

// Which (if any) tracked person is under the crosshair, and which zone of them.
function targetUnderCrosshair(px, py, { includeSelf = false } = {}) {
  let bodyTrack = null;
  const now = performance.now();
  for (const t of state.tracks) {
    if (!isLiveTrack(t, now)) continue;
    if (!includeSelf && t.playerId === localSelfId()) continue;
    if (!isTargetableTrack(t, now)) continue;
    if (contains(headBox(t.box), px, py)) return { track: t, zone: 'head' };
    if (contains(bodyBox(t.box), px, py)) bodyTrack = t;
  }
  return bodyTrack ? { track: bodyTrack, zone: 'body' } : null;
}

function fire() {
  if (!canLocalPlayerFire()) return;
  const now = performance.now();
  if (now - state.lastShotAt < FIRE_COOLDOWN_MS) return;
  state.lastShotAt = now;
  sound.shoot();
  restartAnimation($('fire-btn'), 'firing');

  // The crosshair is the centre of the screen, which is also the centre of the video
  // because the video is scaled with object-fit: cover around its centre.
  if (performance.now() - state.lastGameDetectAt > SHOT_REFRESH_MAX_AGE_MS) {
    refreshGameDetection({ forcePose: rosterCandidateCount() > 1 });
  }
  const hit = targetUnderCrosshair(video.videoWidth / 2, video.videoHeight / 2);
  if (hit?.track.playerId && state.game?.status === 'playing') {
    postHit(hit.track.playerId, hit.zone);
  }
}

async function postHit(targetId, zone) {
  try {
    const res = await fetch('/api/hit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: state.room, shooterId: state.myId, targetId, zone }),
    });
    if (!res.ok && DEBUG) console.warn('hit endpoint rejected shot', await res.text());
  } catch (err) {
    if (DEBUG) console.warn('hit endpoint failed', err);
  }
}

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

function signatureSimilarity(a, b) {
  return (cosine(a?.hist, b?.hist) + cosine(a?.lower, b?.lower) + cosine(a?.grid, b?.grid)) / 3;
}

$('fire-btn').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  fire();
});
$('fire-btn').addEventListener('animationend', () => $('fire-btn').classList.remove('firing'));
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !$('game-screen').hidden) fire();
});

// ---- Detection, identification and drawing loop ----

let lastVideoTime = -1;
let frames = 0;
let fps = 0;
let fpsWindowStart = performance.now();
let inferenceMs = 0;

function loop() {
  requestAnimationFrame(loop);

  if (!state.postProcessingScan && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    if (state.mode === 'scan') {
      const t0 = performance.now();
      state.boxes = detectScanPeople(state.detector, state.poseDetector, video, t0);
      inferenceMs = performance.now() - t0;
      frames++;
    } else {
      const now = performance.now();
      if (now - state.lastGameDetectAt >= gameDetectInterval(now)) {
        refreshGameDetection();
      }
    }
  }

  draw();
  if (state.mode === 'game') updateCountdown();

  if (DEBUG) {
    const now = performance.now();
    if (now - fpsWindowStart >= 1000) {
      fps = (frames * 1000) / (now - fpsWindowStart);
      frames = 0;
      fpsWindowStart = now;
    }
    const visibleTracks = state.tracks.filter((t) => isLiveTrack(t, now));
    const identified = visibleTracks.filter((t) => t.playerId && t.playerId !== localSelfId());
    const rejected = visibleTracks.filter((t) => !t.playerId && t.debugMatch);
    const ranked = visibleTracks.filter((t) => t.rankings?.length);
    const rankName = (rank) => (rank.id === localSelfId() ? 'self' : rank.name);
    $('debug').textContent =
      `${state.delegate} · ${fps.toFixed(0)} fps · ${inferenceMs.toFixed(0)} ms\n` +
      `${video.videoWidth}×${video.videoHeight} · ${state.boxes.length} people · ${visibleTracks.length}/${state.tracks.length} live tracks` +
      (state.mode === 'game'
        ? ` · ${identified.length} identified` +
          (identified.length
            ? `\n${identified
                .map(
                  (t) =>
                    `${t.name}:${t.score.toFixed(2)}${t.hasReid ? ' reid' : ''} u${t.upper?.toFixed(2)} l${t.lower?.toFixed(2)} g${t.grid?.toFixed(2)} s${t.shape?.toFixed(2)} e${t.embed?.toFixed(2)}`,
                )
                .join(' ')}`
            : '')
        : '') +
      (ranked.length
        ? `\nRanks ${ranked
            .map(
              (t) =>
                `#${t.id} ${t.rankings
                  .slice(0, 3)
                  .map((r) => `${rankName(r)}:${r.score.toFixed(2)}/${(r.margin ?? 0).toFixed(2)}`)
                  .join(',')}`,
            )
            .join(' | ')}`
        : '') +
      (rejected.length
        ? `\nRejected ${rejected
            .map(
              (t) =>
                `${rankName(t.debugMatch)}:${t.debugMatch.score.toFixed(2)} ${t.debugMatch.reason} u${t.debugMatch.upper.toFixed(2)} l${t.debugMatch.lower.toFixed(2)} g${t.debugMatch.grid.toFixed(2)} s${t.debugMatch.shape.toFixed(2)} e${(t.debugMatch.embed ?? 0).toFixed(2)}`,
            )
            .join(' ')}`
        : '');
  }
}

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  return { cw, ch };
}

// Same mapping as object-fit: cover, from video pixels to screen pixels.
function videoToScreen(cw, ch) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;
  return { vw, vh, toScreen: (b) => [ox + b.x * scale, oy + b.y * scale, b.w * scale, b.h * scale] };
}

function draw() {
  const { cw, ch } = fitCanvas();
  const mapping = videoToScreen(cw, ch);
  if (!mapping) return;
  if (state.mode === 'scan') drawScan(mapping);
  else drawGame(mapping);
}

// Scan screen: just highlight whoever would be captured if "Capture" were tapped now.
function drawScan({ toScreen }) {
  const target = bestScanBox(state.boxes, video);
  ctx.lineWidth = 3;
  for (const box of state.boxes) {
    ctx.strokeStyle = box === target ? '#39ff88' : 'rgba(255,255,255,0.4)';
    ctx.strokeRect(...toScreen(box));
  }
}

function drawGame({ vw, vh, toScreen }) {
  const cx = vw / 2;
  const cy = vh / 2;
  const hit = targetUnderCrosshair(cx, cy);
  $('crosshair').classList.toggle('on-target', hit !== null);

  ctx.lineWidth = 3;
  ctx.font = '600 13px system-ui, sans-serif';
  const now = performance.now();
  for (const track of state.tracks) {
    if (!isLiveTrack(track, now)) continue;
    const known = track.playerId !== null && track.playerId !== localSelfId();
    const dead = known && isDeadPlayer(track.playerId);
    const alive = known && !dead;
    const targeted = !dead && hit?.track === track;
    const debugMatch = DEBUG && !known && !track.selfRejected ? track.debugMatch : null;
    const color = targeted ? '#ff2e4d' : known && alive ? '#39ff88' : known ? '#6b7280' : debugMatch ? '#ffd166' : '#8a97a6';
    ctx.strokeStyle = color;
    ctx.setLineDash(known && !alive ? [2, 5] : known ? [] : debugMatch ? [8, 4] : [4, 4]);
    ctx.strokeRect(...toScreen(track.box));

    if (alive || !known) {
      ctx.setLineDash([]);
      ctx.strokeRect(...toScreen(bodyBox(track.box)));

      ctx.setLineDash([6, 4]);
      ctx.strokeRect(...toScreen(headBox(track.box)));
    }

    const [x, y] = toScreen(track.box);
    ctx.fillStyle = color;
    ctx.setLineDash([]);
    const label = known ? `${track.name}${dead ? ' down' : ''}` : debugMatch ? `${debugMatch.name}? ${debugMatch.score.toFixed(2)}` : 'Person';
    ctx.fillText(label, x + 4, y + 16);
  }
}

// ---- Small helpers ----

function load(key) {
  try {
    return localStorage.getItem(`laser-tag:${key}`);
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`laser-tag:${key}`, value);
  } catch {
    // Private mode etc.; remembering the name is only a convenience.
  }
}
