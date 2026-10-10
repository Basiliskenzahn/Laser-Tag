// The live round: the frame loop, the overlay, the HUD and the shot.
//
// One requestAnimationFrame loop drives every screen that shows the camera. It runs detection
// only as often as the situation needs - slower once everyone on screen is already identified,
// and on a shrunken copy of the frame - then draws the overlay for whichever screen is up. A
// shot is simply "whose hitbox is in the middle of the screen right now", with a fresh detection
// forced first if the last one is too old to trust, and the server is the judge of the damage.

import { DEBUG, canvas, ctx, video, $ } from '../env.js';
import { bodyBox, contains, detectScanPeople, detectTrackedPeople, detectTrackedPeopleFast, headBox } from '../detector.js';
import { identity } from '../identity.js';
import { gamePlayer, isAlivePlayer, isDeadPlayer, localSelfId, matchingRoster, rosterCandidateCount } from '../roster.js';
import { openGameEvents } from '../net.js';
import { state } from '../state.js';
import * as sound from '../sound.js';
import { drawScan } from './scan.js';
import { hideResults } from './results.js';

const FIRE_COOLDOWN_MS = 350;
const LIVE_TRACK_MS = 520;
const GAME_ACQUIRE_DETECT_INTERVAL_MS = 120;
const GAME_TRACK_DETECT_INTERVAL_MS = 180;
const GAME_POSE_DETECT_INTERVAL_MS = 520;
const SHOT_REFRESH_MAX_AGE_MS = 90;
const GAME_DETECT_MAX_WIDTH = 512;

export function enterGame() {
  $('scan-screen').hidden = true;
  $('lobby-screen').hidden = true;
  hideResults();
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
  return liveTracks.length && liveTracks.every((track) => track.playerId)
    ? GAME_TRACK_DETECT_INTERVAL_MS
    : GAME_ACQUIRE_DETECT_INTERVAL_MS;
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
  identity.observe(state.tracks, t0);
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
      <div class="label"><span>${escapeHtml(p.name)}${p.id === state.myId ? ' (you)' : ''}${p.forfeited ? ' (left)' : ''}</span>${p.wins ? `<span class="wins">★${p.wins}</span>` : ''}</div>
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

// ---- Leaving ----

// Mid-round, leaving is a forfeit: the server counts it as a knockout.
export function openLeaveDialog() {
  $('leave-dialog').showModal();
}

// Also called whenever the game screen goes away: an open modal left inside a hidden screen would
// still make the rest of the page inert.
export function closeLeaveDialog() {
  if ($('leave-dialog').open) $('leave-dialog').close();
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
    const id = identity.resolve(t, now);
    if (!id.playerId || !isAlivePlayer(id.playerId)) continue;
    if (contains(headBox(t.box), px, py)) return { track: t, zone: 'head', identity: id };
    if (contains(bodyBox(t.box), px, py)) bodyHit = { track: t, zone: 'body', identity: id };
  }
  return bodyHit;
}

export function fire() {
  if (!canLocalPlayerFire()) return;
  const now = performance.now();
  if (now - state.lastShotAt < FIRE_COOLDOWN_MS) return;
  state.lastShotAt = now;
  sound.shoot();
  restartAnimation($('crosshair'), 'firing');

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
    // Whatever is identifying people gets a line of its own, if it has anything to say.
    const identityLine = identity.debugLine(now, visibleTracks);
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
      (identityLine ? `\n${identityLine}` : '') +
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
    // Who this is, from every signal that has an opinion: a rejected guess shows as a person.
    const id = identity.resolve(track, now);
    const known = Boolean(id.playerId);
    const dead = known && isDeadPlayer(id.playerId);
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
    const label = known
      ? `${id.name}${dead ? ' down' : id.confirmedBy ? ` (${id.confirmedBy})` : ''}`
      : id.reason === 'vetoed' && DEBUG
        ? `not ${gamePlayer(id.vetoed)?.name ?? 'them'} (${id.vetoedBy})`
        : debugMatch
          ? `${debugMatch.name}? ${debugMatch.score.toFixed(2)}`
          : 'Person';
    ctx.fillText(label, x + 4, y + 16);
  }
}
