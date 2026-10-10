import { bodyBox, createDetector, detectScanPeople, detectTrackedPeople, detectTrackedPeopleFast, headBox, contains } from './detector.js';
import { averageSignatures, extractSignature, scanBoxProblem, Tracker, usableScanBox } from './identify.js';
import { openPolling } from './transport.js';
import * as sound from './sound.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const FIRE_COOLDOWN_MS = 350;
const LIVE_TRACK_MS = 520;
const SCAN_SAMPLE_COUNT = 6;
const SCAN_SAMPLE_INTERVAL_MS = 70;
const SCAN_CACHE_VERSION = 10;
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
const ROTATION_SCAN_COUNTDOWN_MS = 5_000;
const GAME_LAUNCH_COUNTDOWN_MS = 5_000;
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

const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

const ROTATION_SCAN_PROMPT = 'Stand where your whole body is visible and face the camera. When recording starts, slowly turn in one full circle.';

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
  delegate: '',
  mode: 'join', // 'join' | 'lobby' | 'scan' | 'game'
  boxes: [], // people in the latest camera frame, in video pixels
  tracker: new Tracker(),
  tracks: [],
  gallery: [], // signatures captured for the player currently being scanned
  localGallery: [], // this phone owner's gallery, used only as a self-match guard
  scanThumbs: [], // data URLs matching gallery samples, used for the reusable debug cache
  savedScan: null,
  scanTargetId: null,
  scanTargetName: '',
  resumePlayerId: null,
  autoScanning: false,
  postProcessingScan: false,
  loopStarted: false,
  events: null,
  failedConnects: 0, // connection attempts in a row that never opened
  lastShotAt: 0,
  lastGameDetectAt: 0,
  lastGamePoseDetectAt: 0,
  countdownEndsAt: null,
  lastCountdownBeep: null,
  launchingFromLobby: false,
  bannerOverride: null,
};

// ---- Join screen ----

$('name').value = load('name') ?? '';
$('room').value = params.get('room') ?? load('room') ?? 'demo';
for (const input of [$('name'), $('room')]) {
  input.addEventListener('input', () => {
    if (!$('join-btn').hidden) return;
    $('join-btn').hidden = false;
    setJoinStatus('');
  });
}

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  sound.unlock();
  enterLobbyFromForm();
});

async function enterLobbyFromForm({ resumePlayerId = null, auto = false } = {}) {
  state.name = $('name').value.trim();
  state.room = $('room').value.trim().toLowerCase();
  state.resumePlayerId = resumePlayerId;
  state.localGallery = [];
  state.gallery = [];
  state.scanThumbs = [];
  state.scanTargetId = null;
  state.scanTargetName = '';
  state.savedScan = loadScanCache();
  if (state.savedScan?.gallery?.length) state.localGallery = state.savedScan.gallery;
  save('name', state.name);
  save('room', state.room);

  if (!state.name || !state.room) return;
  $('join-btn').hidden = false;
  $('join-btn').disabled = true;
  setJoinStatus(auto ? 'Rejoining lobby...' : 'Starting camera and loading the detector...');
  try {
    await prepareCameraAndDetector();
  } catch (err) {
    console.error(err);
    setJoinStatus(startupErrorMessage(err));
    $('join-btn').disabled = false;
    return;
  }

  video.hidden = true;
  canvas.hidden = true;
  $('join-screen').hidden = true;
  $('lobby-screen').hidden = false;
  $('debug').hidden = !DEBUG;
  keepScreenOn();
  state.mode = 'lobby';
  renderLobby();
  if (!state.loopStarted) {
    state.loopStarted = true;
    requestAnimationFrame(loop);
  }
  connect();
}

function setJoinStatus(text) {
  $('join-status').textContent = text;
}

async function prepareCameraAndDetector() {
  const camera = video.srcObject ? Promise.resolve() : startCamera();
  const detector = state.detector
    ? Promise.resolve({
        detector: state.detector,
        poseDetector: state.poseDetector,
        embedder: state.embedder,
        delegate: state.delegate,
      })
    : createDetector();
  const [, vision] = await Promise.all([camera, detector]);
  state.detector = vision.detector;
  state.poseDetector = vision.poseDetector;
  state.embedder = vision.embedder;
  state.delegate = vision.delegate;
}

function showJoinRejected(message) {
  state.conn?.close();
  state.conn = null;
  state.events?.close();
  state.events = null;
  clearActiveLobby();
  stopCamera();
  hideScanCountdown();
  clearGameCountdown();
  state.mode = 'join';
  state.game = null;
  state.myId = null;
  $('join-screen').hidden = false;
  $('lobby-screen').hidden = true;
  $('scan-screen').hidden = true;
  $('game-screen').hidden = true;
  video.hidden = true;
  canvas.hidden = true;
  $('join-btn').disabled = false;
  $('join-btn').hidden = true;
  setJoinStatus(message);
  showConnectionProblem(null);
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

function stopCamera() {
  for (const track of video.srcObject?.getTracks?.() ?? []) track.stop();
  video.srcObject = null;
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
  const targetName = scanPersonName();
  if (state.postProcessingScan) {
    $('scan-instruction').textContent = `Processing ${targetName}'s rotation...`;
  } else if (state.autoScanning) {
    $('scan-instruction').textContent = `${targetName}: ${ROTATION_SCAN_PROMPT}`;
  } else if (ready) {
    $('scan-instruction').textContent = `${targetName}'s scan is ready. Returning to lobby...`;
  } else if (count > 0) {
    $('scan-instruction').textContent =
      `${count}/${SCAN_TARGET_SAMPLES} samples captured for ${targetName}. Keep rotating slowly.`;
  } else {
    $('scan-instruction').textContent =
      state.savedScan ? `Use ${targetName}'s saved scan, or rescan with a slow rotation.` : `${targetName}: ${ROTATION_SCAN_PROMPT}`;
  }
  updateScanButtons();
  renderSavedScan();
}

function updateScanButtons() {}

function cropThumbnail(box, source = video) {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 64;
  c.getContext('2d').drawImage(source, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

function scanPersonName() {
  return state.scanTargetName || state.name;
}

function scanCacheKey() {
  return `scan:${state.room}:${scanPersonName().toLowerCase()}`;
}

function validScanCache(cache) {
  return (
    cache?.version === SCAN_CACHE_VERSION &&
    cache.name === scanPersonName() &&
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
      name: scanPersonName(),
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

function renderSavedScan() {}

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

function hideScanCountdown() {
  $('scan-screen').classList.remove('countdown');
  $('scan-countdown').hidden = true;
}

function showGameCountdown(label) {
  $('game-screen').classList.add('countdown');
  $('game-countdown').hidden = false;
  $('game-countdown').textContent = label;
  $('banner-text').textContent = label === 'GO!' ? 'Go!' : 'Get ready. Aim when GO appears.';
}

function hideGameCountdown() {
  $('game-screen').classList.remove('countdown');
  $('game-countdown').hidden = true;
}

function clearGameCountdown() {
  state.countdownEndsAt = null;
  state.lastCountdownBeep = null;
  hideGameCountdown();
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
      samples.push(extractSignature(video, box, state.embedder, now));
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
  if (state.localGallery.length) ids.add(localSelfId());
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
        candidates.push({
          signature: extractSignature(frame.image, box, state.embedder, performance.now()),
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

async function runAutoScan() {
  if (state.autoScanning) return;
  let finalMessage = null;
  state.autoScanning = true;
  state.gallery = [];
  state.scanThumbs = [];
  $('scan-thumbs').innerHTML = '';
  updateScanButtons();

  try {
    const readyAt = performance.now() + ROTATION_SCAN_COUNTDOWN_MS;
    while (state.autoScanning && performance.now() < readyAt) {
      const seconds = Math.ceil((readyAt - performance.now()) / 1000);
      showScanCountdown(seconds);
      await wait(120);
    }
    if (!state.autoScanning) return;
    hideScanCountdown();

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
    finalMessage = `Saved scan for ${scanPersonName()} with ${result.samples.length} angles.`;
    state.autoScanning = false;
    saveCurrentScan(finalMessage);
  } catch (err) {
    console.error(err);
    finalMessage = `Could not process the rotation video: ${err.message || err}`;
  } finally {
    state.autoScanning = false;
    hideScanCountdown();
    updateScanButtons();
    if (state.mode === 'scan') {
      startScanStep();
      if (finalMessage) showLobby(finalMessage);
    }
  }
}

$('launch-btn').addEventListener('click', launchGame);
$('leave-lobby-btn').addEventListener('click', leaveLobby);

function scannedGallery(playerId) {
  return state.roster.find((player) => player.id === playerId)?.gallery ?? [];
}

function cloneOwnerId(playerId) {
  const suffix = ':debug-clone';
  return typeof playerId === 'string' && playerId.endsWith(suffix) ? playerId.slice(0, -suffix.length) : null;
}

function playerName(playerId) {
  return (
    state.roster.find((player) => player.id === playerId)?.name ??
    state.game?.players?.find((player) => player.id === playerId)?.name ??
    'player'
  );
}

function hasScan(player) {
  return Boolean(player.gallery?.length);
}

function missingScanPlayers() {
  const players = state.game?.players ?? state.roster;
  return players.filter((player) => !cloneOwnerId(player.id) && !scannedGallery(player.id).length);
}

function renderLobby() {
  $('lobby-room').textContent = `Room ${state.game?.code ?? state.room}`;
  const list = $('lobby-list');
  list.innerHTML = '';
  const players = state.game?.players ?? state.roster;
  for (const player of players) {
    const rosterPlayer = state.roster.find((candidate) => candidate.id === player.id) ?? player;
    const ownerId = cloneOwnerId(player.id);
    const ownerName = ownerId ? playerName(ownerId) : '';
    const gallery = ownerId ? scannedGallery(ownerId) : rosterPlayer.gallery;
    const scanned = Boolean(gallery?.length);
    const row = document.createElement('div');
    row.className = `lobby-player${scanned ? ' scanned' : ''}${ownerId ? ' mirrored' : ''}`;

    const details = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'lobby-name';
    name.textContent = `${player.name}${player.id === state.myId ? ' (you)' : ''}`;
    const status = document.createElement('div');
    status.className = 'lobby-state';
    status.textContent = ownerId
      ? scanned
        ? `Mirrors ${ownerName}'s scan`
        : `Waiting for ${ownerName}'s scan`
      : scanned
        ? `${gallery.length} scan samples ready`
        : 'Not scanned';
    details.append(name, status);

    row.append(details);
    if (!ownerId) {
      const scanBtn = document.createElement('button');
      scanBtn.type = 'button';
      scanBtn.textContent = scanned ? 'Rescan' : 'Scan';
      scanBtn.disabled = state.game?.status === 'countdown' || state.game?.status === 'playing';
      scanBtn.addEventListener('click', () => beginPlayerScan(rosterPlayer));
      row.append(scanBtn);
    }
    list.append(row);
  }
  $('launch-btn').disabled = !state.game || state.game.status === 'countdown' || state.game.status === 'playing';
}

function showLobby(message = '') {
  state.mode = 'lobby';
  state.launchingFromLobby = false;
  state.events?.close();
  state.events = null;
  $('join-screen').hidden = true;
  $('scan-screen').hidden = true;
  hideScanCountdown();
  clearGameCountdown();
  $('game-screen').hidden = true;
  $('lobby-screen').hidden = false;
  video.hidden = true;
  canvas.hidden = true;
  $('lobby-status').textContent = message;
  renderLobby();
}

function leaveLobby() {
  state.autoScanning = false;
  state.postProcessingScan = false;
  state.conn?.close({ notify: true });
  state.conn = null;
  state.events?.close();
  state.events = null;
  clearActiveLobby();
  hideScanCountdown();
  clearGameCountdown();
  state.launchingFromLobby = false;
  stopCamera();
  state.mode = 'join';
  state.myId = null;
  state.game = null;
  state.roster = [];
  state.gallery = [];
  state.localGallery = [];
  state.scanThumbs = [];
  state.scanTargetId = null;
  state.scanTargetName = '';
  $('scan-thumbs').innerHTML = '';
  $('join-screen').hidden = false;
  $('lobby-screen').hidden = true;
  $('scan-screen').hidden = true;
  $('game-screen').hidden = true;
  video.hidden = true;
  canvas.hidden = true;
  $('join-btn').hidden = false;
  $('join-btn').disabled = false;
  setJoinStatus('');
  showConnectionProblem(null);
}

function beginPlayerScan(player) {
  if (!player?.id) return;
  state.scanTargetId = player.id;
  state.scanTargetName = player.name || 'Player';
  state.savedScan = null;
  state.autoScanning = false;
  state.postProcessingScan = false;
  setScanGallery([], []);
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

function saveCurrentScan(message = `Saved scan for ${scanPersonName()}.`) {
  if (!state.scanTargetId || state.gallery.length < SCAN_MIN_SAMPLES) return;
  const gallery = state.gallery;
  if (state.scanTargetId === localSelfId()) state.localGallery = gallery;
  send({ type: 'scan', targetId: state.scanTargetId, gallery });
  saveScanCache();
  showLobby(message);
}

function launchGame() {
  const missing = missingScanPlayers();
  if (missing.length) {
    $('lobby-status').textContent = `Scan everyone before launch: ${missing.map((p) => p.name).join(', ')}`;
    return;
  }
  $('lobby-status').textContent = 'Launching...';
  state.countdownEndsAt = performance.now() + GAME_LAUNCH_COUNTDOWN_MS;
  state.lastCountdownBeep = null;
  state.launchingFromLobby = true;
  enterGame();
  updateCountdown();
  send({ type: 'start' });
}

function enterGame() {
  $('scan-screen').hidden = true;
  $('lobby-screen').hidden = true;
  $('game-screen').hidden = false;
  video.hidden = false;
  canvas.hidden = false;
  state.mode = 'game';
  openGameEvents();
  renderHud();
}

// ---- Networking ----

const UNREACHABLE_MESSAGE = "Can't connect to the game server. Check your internet connection. Still retrying…";
const LOBBY_RUNNING_MESSAGE = 'Lobby is already running.';

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
  if (state.name && state.room) {
    send({
      type: 'join',
      name: state.name,
      room: state.room,
      playerId: state.resumePlayerId,
      gallery: state.localGallery,
      debug: DEBUG,
    });
  }
}

function matchingRoster() {
  const selfId = localSelfId();
  const roster = state.roster.filter((player) => player.id !== selfId);
  if (!state.localGallery.length) return roster;
  const self = { id: selfId, name: 'Person', gallery: state.localGallery };
  return [...roster, self];
}

function localSelfId() {
  return state.myId ?? '__local-self';
}

// Connection problems go on whichever screen is showing: the scan panel or the game banner.
function showConnectionProblem(text) {
  $('scan-connection').textContent = text ?? '';
  $('scan-connection').hidden = !text || state.mode !== 'scan';
  $('lobby-connection').textContent = text ?? '';
  $('lobby-connection').hidden = !text || state.mode !== 'lobby';
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
      state.resumePlayerId = msg.id;
      state.bannerOverride = null;
      saveActiveLobby();
      break;
    case 'error':
      if (!state.myId && [LOBBY_RUNNING_MESSAGE, 'Round already running'].includes(msg.message)) {
        showJoinRejected(LOBBY_RUNNING_MESSAGE);
        return;
      }
      if (state.launchingFromLobby) {
        state.launchingFromLobby = false;
        showLobby(msg.message);
        return;
      }
      state.bannerOverride = msg.message;
      if (state.mode === 'lobby') $('lobby-status').textContent = msg.message;
      renderHud();
      break;
    case 'roster':
      state.roster = msg.players;
      state.localGallery = scannedGallery(localSelfId());
      if (state.mode === 'lobby') renderLobby();
      break;
    case 'scanSaved':
      if (state.mode === 'lobby') $('lobby-status').textContent = 'Scan saved.';
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
  if (game.status === 'countdown' || game.status === 'playing') state.launchingFromLobby = false;
  if (game.status === 'over') {
    const winner = game.players.find((player) => player.id === game.winner);
    const message = game.winner === state.myId ? 'You win!' : `${winner?.name ?? 'Someone'} wins!`;
    if (previous?.status !== 'over') {
      game.winner === state.myId ? sound.win() : sound.lose();
    }
    if (state.mode !== 'lobby') showLobby(message);
    else {
      $('lobby-status').textContent ||= message;
      renderLobby();
    }
    return;
  }
  if ((game.status === 'countdown' || game.status === 'playing') && state.mode === 'lobby') {
    enterGame();
  }
  if (state.mode === 'lobby') renderLobby();
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
  if (state.countdownEndsAt === null) hideGameCountdown();
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
  const remaining = state.countdownEndsAt - performance.now();
  const n = Math.ceil(remaining / 1000);
  const label = n > 0 ? String(n) : 'GO!';
  if (label !== state.lastCountdownBeep) {
    state.lastCountdownBeep = label;
    sound.countdownBeep(n <= 0);
  }
  showGameCountdown(label);
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
    } else if (state.mode === 'game') {
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
                    `${t.name}:${t.score.toFixed(2)} u${t.upper?.toFixed(2)} l${t.lower?.toFixed(2)} g${t.grid?.toFixed(2)} s${t.shape?.toFixed(2)} e${t.embed?.toFixed(2)}`,
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
  else if (state.mode === 'game') drawGame(mapping);
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

function removeSaved(key) {
  try {
    localStorage.removeItem(`laser-tag:${key}`);
  } catch {
    // Private mode etc.; this is only a convenience.
  }
}

function loadActiveLobby() {
  try {
    const lobby = JSON.parse(load('activeLobby'));
    if (
      lobby?.version === 1 &&
      lobby.debug === DEBUG &&
      typeof lobby.name === 'string' &&
      typeof lobby.room === 'string' &&
      typeof lobby.playerId === 'string'
    ) {
      return lobby;
    }
  } catch {
    // Ignore corrupt resume data.
  }
  return null;
}

function saveActiveLobby() {
  if (!state.myId || !state.name || !state.room) return;
  save(
    'activeLobby',
    JSON.stringify({
      version: 1,
      name: state.name,
      room: state.room,
      playerId: state.myId,
      debug: DEBUG,
    }),
  );
}

function clearActiveLobby() {
  removeSaved('activeLobby');
}

function resumeActiveLobby() {
  const lobby = loadActiveLobby();
  if (!lobby) return;
  $('name').value = lobby.name;
  $('room').value = lobby.room;
  enterLobbyFromForm({ resumePlayerId: lobby.playerId, auto: true });
}

resumeActiveLobby();
