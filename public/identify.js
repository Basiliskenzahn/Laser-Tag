// Telling players apart, not just finding "a person".
//
// Plain person detection (detector.js) finds boxes; this module decides *who* is in each box.
// Two cheap, canvas-pixel-only features are extracted per sample - no extra ML model/download,
// so this stays fast enough to run on a phone several times a second:
//
//   hist  - hue/saturation histogram of the torso band. Clothing colour barely changes with
//           viewing angle, so this is the main angle-*invariant* signal.
//   grid  - a coarse colour grid over the whole body box. It's a rough shape+colour
//           fingerprint that DOES change with viewing angle, which is exactly why enrolment
//           takes one grid per angle (front/right/back/left) and matching takes whichever
//           enrolled angle looks closest to the current view.
//
// A learned person re-identification embedding would be more discriminative than `grid` and
// can be dropped in later - extractSignature() is the one place to add it; everything
// downstream (matchGallery, Tracker) just compares whatever vectors come back.

const HUE_BINS = 12;
const SAT_BINS = 4;
const GRID_W = 6;
const GRID_H = 10;

let sampleCanvas = null;
function readPixels(video, box, w, h) {
  sampleCanvas ??= document.createElement('canvas');
  sampleCanvas.width = w;
  sampleCanvas.height = h;
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
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
  for (const v of vec) sumSq += v * v;
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map((v) => v / norm);
}

// Hue/saturation histogram of the torso - the band just below the head box.
function torsoHistogram(video, box) {
  const torso = { x: box.x + box.w * 0.2, y: box.y + box.h * 0.22, w: box.w * 0.6, h: box.h * 0.38 };
  const px = readPixels(video, torso, 12, 20);
  const hist = new Array(HUE_BINS * SAT_BINS).fill(0);
  for (let i = 0; i < px.length; i += 4) {
    const [hue, sat] = rgbToHueSat(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
    if (sat < 0.12) continue; // greys/whites/blacks carry ~no hue information
    const hb = Math.min(HUE_BINS - 1, Math.floor((hue / 360) * HUE_BINS));
    const sb = Math.min(SAT_BINS - 1, Math.floor(sat * SAT_BINS));
    hist[hb * SAT_BINS + sb] += 1;
  }
  return normalize(hist);
}

// Coarse colour grid over the whole body box.
function bodyGrid(video, box) {
  const px = readPixels(video, box, GRID_W, GRID_H);
  const grid = new Array(GRID_W * GRID_H * 3);
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    grid[i * 3] = px[i * 4] / 255;
    grid[i * 3 + 1] = px[i * 4 + 1] / 255;
    grid[i * 3 + 2] = px[i * 4 + 2] / 255;
  }
  return normalize(grid);
}

// { hist, grid } for one video frame + box. Used both at enrolment (one per angle) and live.
export function extractSignature(video, box) {
  return { hist: torsoHistogram(video, box), grid: bodyGrid(video, box) };
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both vectors are already L2-normalised
}

const HIST_WEIGHT = 0.6;
const GRID_WEIGHT = 0.4;

function similarity(a, b) {
  return HIST_WEIGHT * cosine(a.hist, b.hist) + GRID_WEIGHT * cosine(a.grid, b.grid);
}

// The best-matching enrolled angle wins - this is what makes matching tolerant of whatever
// angle the camera currently sees the player from.
function bestAngleScore(signature, gallery) {
  let best = -Infinity;
  for (const sample of gallery) best = Math.max(best, similarity(signature, sample));
  return best;
}

const MATCH_THRESHOLD = 0.72; // below this, call it unknown rather than guess
const MATCH_MARGIN = 0.05; // the winner must clear the runner-up by this much

// players: [{ id, name, gallery: [{hist, grid}, ...] }, ...]
// excludeId: the local player - never matched against their own gallery.
export function matchGallery(signature, players, excludeId) {
  let best = null;
  let secondScore = -Infinity;
  for (const player of players) {
    if (player.id === excludeId || !player.gallery?.length) continue;
    const score = bestAngleScore(signature, player.gallery);
    if (!best || score > best.score) {
      if (best) secondScore = best.score;
      best = { id: player.id, name: player.name, score };
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (!best || best.score < MATCH_THRESHOLD) return null;
  if (best.score - secondScore < MATCH_MARGIN) return null; // too close to call
  return best;
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

const IOU_MATCH = 0.3;
const TRACK_TIMEOUT_MS = 500;
const RECHECK_MS = 400; // re-identify an established track about every 0.4s
const SETTLE_CHECKS = 3; // identify fast on a brand new track: check every frame at first
const SWITCH_STREAK = 3; // a rival id must win this many checks in a row before we switch

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
  update(boxes, video, players, selfId, now = performance.now()) {
    const unmatched = new Set(boxes.map((_, i) => i));
    for (const track of this.tracks) {
      let bestI = -1;
      let bestIou = IOU_MATCH;
      for (const i of unmatched) {
        const score = iou(track.box, boxes[i]);
        if (score > bestIou) {
          bestIou = score;
          bestI = i;
        }
      }
      if (bestI >= 0) {
        track.box = boxes[bestI];
        track.lastSeen = now;
        track.checks++;
        unmatched.delete(bestI);
      }
    }
    for (const i of unmatched) {
      this.tracks.push({
        id: this.nextId++,
        box: boxes[i],
        lastSeen: now,
        checks: 1,
        lastCheck: 0,
        playerId: null,
        name: null,
        score: 0,
        streakId: undefined,
        streak: 0,
      });
    }
    this.tracks = this.tracks.filter((t) => now - t.lastSeen < TRACK_TIMEOUT_MS);

    for (const track of this.tracks) {
      if (track.lastSeen !== now) continue; // not seen this frame, nothing to re-check
      const due = track.checks <= SETTLE_CHECKS || now - track.lastCheck >= RECHECK_MS || !track.playerId;
      if (!due) continue;
      track.lastCheck = now;

      const signature = extractSignature(video, track.box);
      const match = matchGallery(signature, players, selfId);
      const candidateId = match?.id ?? null;

      if (candidateId === track.playerId) {
        track.streak = 0;
        if (match) track.score = match.score;
      } else if (candidateId === track.streakId) {
        track.streak++;
        if (!track.playerId || track.streak >= SWITCH_STREAK) {
          track.playerId = candidateId;
          track.name = match?.name ?? null;
          track.score = match?.score ?? 0;
          track.streak = 0;
          track.streakId = undefined;
        }
      } else {
        track.streakId = candidateId;
        track.streak = 1;
      }
    }
    return this.tracks;
  }
}
