// Enrolment: recording what one player looks like, so that during the match other phones can
// tell *who* is under the crosshair instead of just seeing "a person".
//
// The player stands in full view and turns one slow circle while frames are recorded; afterwards
// every frame is scored for framing, light, contrast and sharpness, and only the best and most
// different-looking angles survive - near-duplicates and outliers are dropped, because a gallery
// of one pose matches everybody. A finished scan is cached in localStorage so a reload does not
// mean rotating again.

import { canvas, ctx, video, $ } from '../env.js';
import { detectScanPeople } from '../detector.js';
import { averageSignatures, extractSignature, scanBoxProblem, usableScanBox } from '../identify.js';
import { keepScreenOn } from '../camera.js';
import { send } from '../net.js';
import { localSelfId } from '../roster.js';
import { state } from '../state.js';
import { showLobby } from './lobby.js';

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
const ROTATION_SCAN_COUNTDOWN_MS = 3_000;
const ROTATION_SCAN_DURATION_MS = 12_000;
const ROTATION_RECORD_FRAME_MS = 180;
const ROTATION_FRAME_MAX_WIDTH = 1024;
const ROTATION_SAMPLE_AVERAGE_COUNT = 4;

const ROTATION_SCAN_PROMPT = 'Stand where your whole body is visible and face the camera. When recording starts, slowly turn in one full circle.';

function startScanStep() {
  const count = state.gallery.length;
  const ready = count >= SCAN_MIN_SAMPLES;
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
}

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

export function loadScanCache() {
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
  } catch {
    // The scan cache is only a debug convenience; the live scan still works.
  }
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
    if (state.mode === 'scan') {
      startScanStep();
      if (finalMessage) showLobby(finalMessage);
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

// recordRotationVideo/processRotationVideo/runAutoScan all check state.autoScanning on every
// loop iteration and bail cleanly when it goes false, so cancelling is just flipping that flag
// and leaving the scan screen - their own `finally` blocks notice state.mode is no longer
// 'scan' and skip touching the UI again.
export function cancelScan() {
  state.autoScanning = false;
  state.postProcessingScan = false;
  showLobby('Scan cancelled.');
}

function saveCurrentScan(message = `Saved scan for ${scanPersonName()}.`) {
  if (!state.scanTargetId || state.gallery.length < SCAN_MIN_SAMPLES) return;
  const gallery = state.gallery;
  if (state.scanTargetId === localSelfId()) state.localGallery = gallery;
  send({ type: 'scan', targetId: state.scanTargetId, gallery });
  saveScanCache();
  showLobby(message);
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

// Scan screen: just highlight whoever would be captured if "Capture" were tapped now.
export function drawScan({ toScreen }) {
  const target = bestScanBox(state.boxes, video);
  ctx.lineWidth = 3;
  for (const box of state.boxes) {
    ctx.strokeStyle = box === target ? '#39ff88' : 'rgba(255,255,255,0.4)';
    ctx.strokeRect(...toScreen(box));
  }
}
