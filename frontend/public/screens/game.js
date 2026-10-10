// The live round: the frame loop, the overlay, the HUD and the shot.
//
// One requestAnimationFrame loop drives every screen that shows the camera. It runs detection
// only as often as the situation needs - slower once everyone on screen is already identified,
// and on a shrunken copy of the frame - then draws the overlay for whichever screen is up. A
// shot is simply "whose hitbox is in the middle of the screen right now", with a fresh detection
// forced first if the last one is too old to trust, and the server is the judge of the damage.

import { DEBUG, canvas, ctx, video, $ } from '../env.js';
import {
  bodyBox,
  contains,
  detectScanPeople,
  detectTrackedPeople,
  detectTrackedPeopleFast,
  detectZoomedPeople,
  headBox,
  mergeZoomedPeople,
} from '../detector.js';
import { motionDebugLine, motionScoreAdjustment, recordTrackMotion, resolveIdentity } from '../motion-identity.js';
import { getReidThreshold } from '../identify.js';
import { gamePlayer, isAlivePlayer, isDeadPlayer, localSelfId, matchingRoster, rosterCandidateCount } from '../roster.js';
import { openGameEvents } from '../net.js';
import { state } from '../state.js';
import * as sound from '../sound.js';
import { drawScan } from './scan.js';

const FIRE_COOLDOWN_MS = 350;
const LIVE_TRACK_MS = 520;
const GAME_ACQUIRE_DETECT_INTERVAL_MS = 80;
const GAME_TRACK_DETECT_INTERVAL_MS = 120;
// Detection may take at most this share of the time, so slower phones slow it down themselves
// instead of starving the drawing and the shot.
const DETECT_MAX_BUSY_SHARE = 0.7;
const GAME_POSE_DETECT_INTERVAL_MS = 520;
const SHOT_REFRESH_MAX_AGE_MS = 90;
const GAME_DETECT_MAX_WIDTH = 512;
// Run the zoom pass for far people (detector.js detectZoomedPeople) on every Nth detection.
const GAME_ZOOM_EVERY = 2;
let gameDetections = 0;

export function enterGame() {
  $('scan-screen').hidden = true;
  $('lobby-screen').hidden = true;
  $('game-screen').hidden = false;
  video.hidden = false;
  canvas.hidden = false;
  state.mode = 'game';
  openGameEvents();
  renderHud();
}

// ---- Detection ----

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
  const base =
    liveTracks.length && liveTracks.every((track) => track.playerId) ? GAME_TRACK_DETECT_INTERVAL_MS : GAME_ACQUIRE_DETECT_INTERVAL_MS;
  return Math.max(base, inferenceMs / DETECT_MAX_BUSY_SHARE);
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
  if (++gameDetections % GAME_ZOOM_EVERY === 0) state.boxes = mergeZoomedPeople(state.boxes, detectZoomedPeople(state.detector, video, t0 + 1));
  state.tracks = state.tracker.update(state.boxes, video, matchingRoster(), localSelfId(), t0, {
    includeRejected: DEBUG,
    identifyOnce: false,
    embedder: state.embedder,
    reid: state.reid,
    closedSet: true,
    scoreAdjust: motionScoreAdjustment,
  });
  recordTrackMotion(state.tracks, t0);
  state.lastGameDetectAt = t0;
  inferenceMs = performance.now() - t0;
  frames++;
  return true;
}

// ---- HUD ----

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

export function clearGameCountdown() {
  state.countdownEndsAt = null;
  state.lastCountdownBeep = null;
  hideGameCountdown();
}

export function renderHud() {
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

export function updateCountdown() {
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

export function popup(text, headshot) {
  const el = document.createElement('div');
  el.className = `popup${headshot ? ' headshot' : ''}`;
  el.textContent = text;
  $('popups').append(el);
  el.addEventListener('animationend', () => el.remove());
}

export function restartAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // force a reflow so the animation plays again
  el.classList.add(className);
}

// ---- Shooting ----

function isLiveTrack(track, now = performance.now()) {
  return now - track.lastSeen <= LIVE_TRACK_MS;
}

// Between detections (which run only a few times a second on a phone), move each box along its
// track's recent velocity, at most a quarter second ahead, so it follows the person smoothly. The
// shot uses the same box as the overlay: what you see is what you hit.
function liveBox(track, now) {
  const dt = Math.min(0.25, Math.max(0, (now - (track.lastUpdated ?? track.lastSeen)) / 1000));
  return { ...track.box, x: track.box.x + (track.vx ?? 0) * dt, y: track.box.y + (track.vy ?? 0) * dt };
}

function canLocalPlayerFire() {
  return state.mode === 'game' && state.game?.status === 'playing' && isAlivePlayer(localSelfId());
}

// Which (if any) valid target is under the crosshair, which zone, and who it is.
function targetUnderCrosshair(px, py) {
  if (state.game?.status !== 'playing') return null;
  let bodyHit = null;
  const now = performance.now();
  for (const t of state.tracks) {
    if (!isLiveTrack(t, now)) continue;
    const id = resolveIdentity(t, now);
    if (!id.playerId || !isAlivePlayer(id.playerId)) continue;
    const box = liveBox(t, now);
    if (contains(headBox(box), px, py)) return { track: t, zone: 'head', identity: id };
    if (contains(bodyBox(box), px, py)) bodyHit = { track: t, zone: 'body', identity: id };
  }
  return bodyHit;
}

export function fire() {
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
  if (hit) postHit(hit.identity.playerId, hit.zone);
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

// ---- Detection, identification and drawing loop ----

let lastVideoTime = -1;
let frames = 0;
let fps = 0;
let fpsWindowStart = performance.now();
let inferenceMs = 0;

export function loop() {
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
      `${state.delegate} · ${fps.toFixed(0)} fps · ${inferenceMs.toFixed(0)} ms · reid ≥ ${getReidThreshold().toFixed(2)}\n` +
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
      `\n${motionDebugLine(now, visibleTracks)}` +
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
    // The classifier's identity, confirmed or vetoed by motion: a vetoed guess shows as a person.
    const id = resolveIdentity(track, now);
    const known = Boolean(id.playerId);
    const dead = known && isDeadPlayer(id.playerId);
    const alive = known && !dead;
    const targeted = !dead && hit?.track === track;
    const debugMatch = DEBUG && !known && !track.selfRejected ? track.debugMatch : null;
    const color = targeted ? '#ff2e4d' : known && alive ? '#39ff88' : known ? '#6b7280' : debugMatch ? '#ffd166' : '#8a97a6';
    const box = liveBox(track, now);
    ctx.strokeStyle = color;
    ctx.setLineDash(known && !alive ? [2, 5] : known ? [] : debugMatch ? [8, 4] : [4, 4]);
    ctx.strokeRect(...toScreen(box));

    if (alive || !known) {
      ctx.setLineDash([]);
      ctx.strokeRect(...toScreen(bodyBox(box)));

      ctx.setLineDash([6, 4]);
      ctx.strokeRect(...toScreen(headBox(box)));
    }

    const [x, y] = toScreen(box);
    ctx.fillStyle = color;
    ctx.setLineDash([]);
    // In debug mode every box also shows its best match and score, for tuning ?reid= in the field.
    const best = DEBUG ? (track.rankings ?? []).find((r) => r.id !== localSelfId()) : null;
    // Typical (median) score including motion, this check's in brackets when it differs, and the
    // motion part when there is one.
    const latestNote = best?.rawScore != null && Math.abs(best.rawScore - best.score) >= 0.005 ? ` (now ${best.rawScore.toFixed(2)})` : '';
    const motionNote = best?.motionAdjust ? ` motion${best.motionAdjust > 0 ? '+' : ''}${best.motionAdjust.toFixed(2)}` : '';
    const scoreNote = best ? ` [${best.name} ${best.score.toFixed(2)}${latestNote}${motionNote}${best.hasReid ? '' : ' colour'}]` : '';
    const label = (known
      ? `${id.name}${dead ? ' down' : id.source === 'both' ? ' (moves)' : ''}`
      : id.reason === 'vetoed' && DEBUG
        ? `not ${gamePlayer(id.vetoed)?.name ?? 'them'} (motion)`
        : debugMatch
          ? `${debugMatch.name}? ${debugMatch.score.toFixed(2)}`
          : 'Person') + scoreNote;
    ctx.fillText(label, x + 4, y + 16);
  }
}
