// Telling players apart, not just finding "a person".
//
// Plain person detection (detector.js) finds boxes; this module decides *who* is in each box.
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

const HUE_BINS = 12;
const SAT_BINS = 4;
const LUMA_BINS = 8;
const SAT_DETAIL_BINS = 8;
const GRID_W = 6;
const GRID_H = 8;
const GRID_FEATURES = 4;
const EMBED_DIMS = 256;
const EMBED_PRECISION = 10_000;
const MIN_SCAN_HEIGHT_RATIO = 0.18;
const MIN_MATCH_HEIGHT_RATIO = 0.18;
const MIN_BOX_WIDTH_RATIO = 0.035;
const MIN_ASPECT = 0.58;
const MAX_ASPECT = 6.5;
const MIN_SCAN_ASPECT = 0.65;
const MAX_SCAN_ASPECT = 7.0;

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
  const edgePad = Math.min(vw, vh) * 0.01;
  const clipped =
    box.x <= edgePad || box.y <= edgePad || box.x + box.w >= vw - edgePad || box.y + box.h >= vh - edgePad;
  return { aspect, heightRatio, widthRatio, clipped };
}

function boxQuality(source, box, minHeightRatio, { scan = false } = {}) {
  const m = boxMetrics(source, box);
  const minWidthRatio = scan ? 0.025 : MIN_BOX_WIDTH_RATIO;
  const minAspect = scan ? MIN_SCAN_ASPECT : MIN_ASPECT;
  const maxAspect = scan ? MAX_SCAN_ASPECT : MAX_ASPECT;
  const clippedHeight = scan ? 0.42 : 0.55;
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

export function averageSignatures(signatures) {
  return {
    hist: averageVectors(signatures.map((s) => s.hist)),
    lower: averageVectors(signatures.map((s) => s.lower)),
    grid: averageVectors(signatures.map((s) => s.grid)),
    shape: averageVectors(signatures.map((s) => s.shape)),
    embed: averageVectors(signatures.map((s) => s.embed).filter((v) => v?.length)),
    usable: signatures.some((s) => s.usable !== false),
  };
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

function shapeSimilarity(a, b) {
  const aspectA = a?.[0];
  const aspectB = b?.[0];
  if (!Number.isFinite(aspectA) || !Number.isFinite(aspectB) || aspectA <= 0 || aspectB <= 0) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(aspectA / aspectB)) / Math.log(2.2));
}

const HIST_WEIGHT = 0.42;
const LOWER_WEIGHT = 0.24;
const GRID_WEIGHT = 0.24;
const SHAPE_WEIGHT = 0.1;
const EMBED_HIST_WEIGHT = 0.3;
const EMBED_LOWER_WEIGHT = 0.18;
const EMBED_GRID_WEIGHT = 0.16;
const EMBED_SHAPE_WEIGHT = 0.06;
const EMBED_WEIGHT = 0.3;
const GALLERY_TOP_MATCH_COUNT = 3;
const GALLERY_AGREEMENT_WINDOW = 0.1;
const GALLERY_AGREEMENT_WEIGHT = 0.25;
const GALLERY_SUPPORT_BONUS = 0.012;

function similarityParts(a, b) {
  const upper = cosine(a.hist, b.hist);
  const lower = cosine(a.lower, b.lower);
  const grid = cosine(a.grid, b.grid);
  const shape = shapeSimilarity(a.shape, b.shape);
  const embed = cosine(a.embed, b.embed);
  const hasEmbed = Boolean(a.embed?.length && b.embed?.length);
  return {
    upper,
    lower,
    grid,
    shape,
    embed,
    score: hasEmbed
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

const MATCH_THRESHOLD = 0.54; // below this, call it unknown rather than guess
const MATCH_MARGIN = 0.06; // the winner must clear the runner-up by this much
const MIN_UPPER_SCORE = 0.5;
const MIN_LOWER_SCORE = 0.38;
const MIN_GRID_SCORE = 0.4;
const MIN_SHAPE_SCORE = 0.36;

function rejectionReason(best, candidates, secondScore) {
  if (!best) return 'no-candidate';
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
  if (closedSet && best) return { ...best, accepted: true, reason, candidates, rankings };
  if (!reason) return { ...best, accepted: true, candidates };
  return includeRejected && best ? { ...best, accepted: false, reason, candidates, rankings } : null;
}

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

function predictedBox(track, now) {
  const dt = Math.min(0.5, Math.max(0, (now - (track.lastUpdated || track.lastSeen || now)) / 1000));
  return {
    ...track.box,
    x: track.box.x + (track.vx ?? 0) * dt,
    y: track.box.y + (track.vy ?? 0) * dt,
  };
}

function associationScore(track, box, now) {
  const predicted = predictedBox(track, now);
  const overlap = iou(predicted, box);
  const distance = centerScore(predicted, box);
  if (overlap < 0.08 && distance < 0.35) return 0;
  return overlap * 0.5 + distance * 0.35 + sizeScore(predicted, box) * 0.15;
}

function updateTrackBox(track, box, now) {
  const previous = center(track.box);
  const dt = Math.max(0.016, (now - (track.lastUpdated || track.lastSeen || now)) / 1000);
  const smoothed = blendBox(track.box, box, 0.68);
  const next = center(smoothed);
  track.vx = (next.x - previous.x) / dt;
  track.vy = (next.y - previous.y) / dt;
  track.box = smoothed;
  track.lastSeen = now;
  track.lastUpdated = now;
  track.seenThisFrame = true;
  track.missedFrames = 0;
  track.checks++;
}

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
  track.rankings = [];
  track.streak = 0;
  track.streakId = undefined;
  track.identifiedAt = null;
  track.identityHits = 0;
  track.lastEnrichedAt = 0;
}

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
    duplicates.sort((a, b) => identityConfidence(b, now) - identityConfidence(a, now));
    for (const duplicate of duplicates.slice(1)) clearIdentity(duplicate);
  }
}

function resolveClosedSetIdentities(tracks, now) {
  const visible = tracks.filter((track) => track.lastSeen === now && track.rankings?.length);
  if (visible.length < 2) return;

  const pairs = [];
  for (const track of visible) {
    for (const candidate of track.rankings) {
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

const ASSOCIATION_MATCH = 0.3;
const TRACK_TIMEOUT_MS = 900;
const RECHECK_MS = 250; // re-identify an established track quickly without checking every frame forever
const SETTLE_CHECKS = 6; // identify fast on a brand new track: check every frame at first
const INITIAL_STREAK = 2; // a new track must agree a couple of times before getting a name
const SWITCH_STREAK = 4; // a rival id must win this many checks in a row before we switch
const HIGH_CONFIDENCE_INITIAL_LOCK = 0.66;
const EVIDENCE_DECAY = 0.82;
const EVIDENCE_ACCEPT = 0.58;
const EVIDENCE_MARGIN = 0.12;
const EVIDENCE_MIN_SCORE = 0.42;
const EVIDENCE_MIN_PART = 0.24;
const SOFT_LABEL_SCORE = 0.48;

function decayEvidence(track) {
  for (const [id, value] of track.evidence) {
    const decayed = value * EVIDENCE_DECAY;
    if (decayed < 0.05) track.evidence.delete(id);
    else track.evidence.set(id, decayed);
  }
}

function evidenceWeight(match) {
  if (!match) return 0;
  if (
    match.score < EVIDENCE_MIN_SCORE ||
    match.upper < EVIDENCE_MIN_PART ||
    match.lower < EVIDENCE_MIN_PART ||
    match.grid < EVIDENCE_MIN_PART ||
    match.shape < EVIDENCE_MIN_PART
  ) {
    return 0;
  }
  return match.accepted ? 1.25 : 0.45 + Math.max(0, match.score - EVIDENCE_MIN_SCORE);
}

function softLabelMatch(match) {
  if (!match || match.accepted || match.reason === 'margin') return null;
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
  track.playerId = match?.id ?? null;
  track.name = match?.name ?? null;
  track.score = match?.score ?? 0;
  track.upper = match?.upper ?? 0;
  track.lower = match?.lower ?? 0;
  track.grid = match?.grid ?? 0;
  track.shape = match?.shape ?? 0;
  track.embed = match?.embed ?? 0;
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
    { includeRejected = false, embedder = null, identifyOnce = false, closedSet = false } = {},
  ) {
    for (const track of this.tracks) track.seenThisFrame = false;

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

    for (const track of this.tracks) {
      if (track.seenThisFrame) continue;
      const age = now - track.lastSeen;
      if (age < TRACK_TIMEOUT_MS) {
        track.vx = (track.vx ?? 0) * 0.82;
        track.vy = (track.vy ?? 0) * 0.82;
        track.missedFrames = (track.missedFrames ?? 0) + 1;
      }
    }

    for (let i = 0; i < boxes.length; i++) {
      if (matchedBoxes.has(i)) continue;
      this.tracks.push({
        id: this.nextId++,
        box: boxes[i],
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
      const match = matchGallery(signature, players, selfId, { includeRejected: true, closedSet });
      track.rankings = match?.rankings ?? (match ? [match] : []);
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
          candidateMatch.score >= HIGH_CONFIDENCE_INITIAL_LOCK
        ) {
          assignIdentity(track, candidateMatch);
        }
      }
    }
    if (closedSet) resolveClosedSetIdentities(this.tracks, now);
    else resolveDuplicateIdentities(this.tracks, now);
    return this.tracks;
  }
}
