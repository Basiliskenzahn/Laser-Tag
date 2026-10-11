// The live round: the frame loop, the overlay, the HUD and the shot.
//
// One requestAnimationFrame loop drives every screen that shows the camera. It runs detection as
// fast as the phone can stand - on a shrunken copy of the frame, aiming for the target cadence and
// backing off only when the phone cannot keep up (see DETECT_MAX_BUSY_SHARE) - then draws the
// overlay for whichever screen is up. A shot is simply "whose hitbox is in the middle of the screen
// right now", resolved against the same projected boxes the crosshair was drawn from and with no
// inference of its own, and the server judges the damage.

import { DEBUG, canvas, ctx, video, $ } from '../env.js';
import { bodyBox, contains, detectTrackedPeople, detectTrackedPeopleFast, headBox } from '../detector.js';
import { frameMotionHint, frameMotionWorthSampling, sampleFrameMotion } from '../frame-motion.js';
import { RECHECK_MS, getReidThreshold } from '../identify.js';
import { isAlivePlayer, isDeadPlayer, localSelfId, matchingRoster, rosterCandidateCount } from '../roster.js';
import { startupTimingLine } from '../startup.js';
import { state } from '../state.js';
import { targetPlayerId } from '../target.js';
import * as sound from '../sound.js';
import { drawScan, scanCostLine } from './scan.js';
import { hideResults } from './results.js';

const FIRE_COOLDOWN_MS = 350;
const LIVE_TRACK_MS = 520;

// -- detection cadence --
// Two tiers, picked per frame by detectTier(). The fast one is the target the whole branch is
// aimed at; the slow one is what the game actually needs when there is nothing to look for, and
// paying it is what buys the fast tier its headroom.
//
// 50 ms is 20 fps. Worked through the duty cap below, any phone under ~35 ms per detection hits it
// outright (35 / 0.7 = 50), and slower ones degrade smoothly rather than stuttering: 50 ms per
// detection settles at 71 ms (14 fps), 70 ms at 100 ms (10 fps). The one measured figure in the
// repo is 23 ms, which is 46% duty at this interval - headroom that the old 30 fps proposal did
// not leave, and that the FIRE button needs.
const DETECT_INTERVAL_SEARCHING_MS = 50;
// 100 ms is 10 fps, and it is plenty when every live track is identified and none is coasting: the
// boxes are drawn every animation frame from liveBox()'s velocity projection, not from the last
// detection, so a slower detection rate costs smoothness almost nothing. It also still clears the
// identification floor (RECHECK_MS), so names keep updating at the same rate either way.
const DETECT_INTERVAL_SETTLED_MS = 100;
// Detection may take at most this share of the time, so slower phones slow it down themselves
// instead of starving the drawing and the shot.
const DETECT_MAX_BUSY_SHARE = 0.7;

// -- the pose landmarker, gameplay's second chance at a person the object detector missed --
const GAME_POSE_DETECT_INTERVAL_MS = 520;
// While a track is coasting, let pose run sooner. That is precisely the job detector.js built it
// for ("a pose nowhere near any surviving object box is a person the object detector missed"), and
// it is bounded by construction rather than by a timer: a track coasts for at most
// TRACK_TIMEOUT_MS (900 ms in identify.js) before it is dropped, so a lost person can hold the
// faster pose rate for about a second and no longer.
const GAME_POSE_SEARCH_INTERVAL_MS = 200;

const GAME_DETECT_MAX_WIDTH = 512;

// What the ?debug readout prints each achieved rate against. Derived, never typed twice: a retune
// of either interval moves the target in the overlay with it.
const DETECT_TARGET_FPS = Math.round(1000 / DETECT_INTERVAL_SEARCHING_MS);
const ID_TARGET_HZ = Math.round(1000 / RECHECK_MS);
// The scan screen's preview detection - the green box round whoever a scan would use. It used to
// run on every new video frame, through detectScanPeople (object detector *plus* pose landmarker)
// and on the full-resolution video, which made the idle scan screen by far the most expensive
// thing in the app: about 180 object and 180 pose inferences at ~0.92 Mpx during a 3 s countdown
// and a 12 s recording, none of which goes anywhere near the gallery. The gallery is built later,
// from the recorded canvases, by processRotationVideo.
//
// So the preview is now what it always should have been: the cheap object-only pass, on the same
// 512-wide copy gameplay detects on, a few times a second. It is a highlight, not a measurement.
// And it is skipped outright while the recording is running, because there the player has been
// told to turn in a circle - the box is behind them, nobody is looking at the screen, and the
// frame capture wants the main thread. Anything that reads `state.boxes` on this screen only
// draws with it (drawScan), so none of this can reach an enrolled signature.
const SCAN_PREVIEW_DETECT_INTERVAL_MS = 150;
// During the rotation the frame capture owns the thread; the box is a reassurance, not a measurement.
const RECORDING_PREVIEW_DETECT_INTERVAL_MS = 400;

export function enterGame() {
  $('scan-screen').hidden = true;
  $('lobby-screen').hidden = true;
  hideResults();
  // A hit effect cut short by the screen hiding (Leave right after a hit) never got its
  // animationend, and would replay the moment the screen shows again.
  $('damage').classList.remove('flash');
  $('crosshair').classList.remove('firing', 'hit');
  $('cooldown').classList.remove('cooling');
  $('popups').replaceChildren();
  clearHitBars();
  for (const bar of $('hud').querySelectorAll('.hurt')) bar.classList.remove('hurt');
  $('game-screen').hidden = false;
  video.hidden = false;
  canvas.hidden = false;
  state.mode = 'game';
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

// See SCAN_PREVIEW_DETECT_INTERVAL_MS. The box runs through the recording too, at a slower
// cadence: it used to be skipped entirely there on the grounds that the player has been told to
// turn in a circle and nobody is looking at the screen. In practice the box vanishing reads as a
// fault, so it stays - but at RECORDING_PREVIEW_DETECT_INTERVAL_MS, because recordRotationVideo
// is capturing a frame every ROTATION_RECORD_FRAME_MS on the same thread and a dropped capture
// costs a usable angle in the gallery, which matters more than the box does.
function refreshScanPreview() {
  const now = performance.now();
  const interval = state.recordingScan ? RECORDING_PREVIEW_DETECT_INTERVAL_MS : SCAN_PREVIEW_DETECT_INTERVAL_MS;
  if (now - state.lastScanPreviewAt < interval) return;
  state.lastScanPreviewAt = now;
  const { source, scaleX, scaleY } = gameplayInferenceSource();
  state.boxes = scaleBoxes(detectTrackedPeopleFast(state.detector, source, now), scaleX, scaleY);
  inferenceMs = performance.now() - now;
  frames++;
}

// Is there someone on screen we are still looking for? Two states count, and both are things the
// app *knows* rather than guesses:
//
//   'lost'       a live track the detector did not find this cycle, coasting on liveBox()'s
//                velocity (missedFrames > 0). We saw that person a moment ago, so this is a real
//                missed detection, not an absence - and it is the one the player notices, because
//                the box drifts off someone standing right in front of them.
//   'motion'     something in the frame moved where neither a box nor a live track accounts for
//                it (frame-motion.js). This is the one state here that is a *guess* rather than
//                something the app knows - but it is the only state that speaks for a person the
//                object detector never found at all, which the other two cannot: both of them
//                need a track to already exist. EfficientDet-Lite0's 320x320 tensor loses a
//                person long before the camera stops seeing them move, so this is where the
//                extra range comes from. It is bounded in frame-motion.js rather than here, by a
//                refractory on the hint, so a moving curtain cannot hold the fast tier open.
//   'acquiring'  a live track with no identity yet. Already the state the old two-tier split was
//                built around.
//
// Deliberately NOT a third state for "an enrolled, alive player has no live track". From inside
// the app that is indistinguishable from a player who has walked out of frame, and the mitigation
// would be an escalation nothing can end: a player who leaves the area is missing forever, and the
// phone would sit pinned at the fast tier with pose relaxed for the rest of the round. The settled
// tier is 10 fps, which finds somebody walking back into frame within about 100 ms anyway.
//
// `null` means everything on screen is found and named, which is the tier the game can afford to
// be slow in.
export function detectTier(now = performance.now()) {
  let acquiring = false;
  for (const track of state.tracks) {
    if (!isLiveTrack(track, now)) continue;
    if ((track.missedFrames ?? 0) > 0) return 'lost'; // strongest signal, so it wins outright
    if (!track.playerId) acquiring = true;
  }
  // Movement outranks 'acquiring' because the two want different work. An acquiring track has
  // already been found - more detection will not name it any sooner, since naming is throttled by
  // RECHECK_MS and by re-identification, not by the detection rate. Unaccounted-for movement is
  // somebody not found yet, and detection is exactly what finds them.
  if (frameMotionHint(now)) return 'motion';
  return acquiring ? 'acquiring' : null;
}

function gameDetectInterval(now, tier = detectTier(now)) {
  const base = tier ? DETECT_INTERVAL_SEARCHING_MS : DETECT_INTERVAL_SETTLED_MS;
  return Math.max(base, inferenceMs / DETECT_MAX_BUSY_SHARE);
}

// Pose costs the most of anything in the loop and it inflates `inferenceMs`, which feeds the duty
// cap above - so the cycle *after* a pose cycle is stretched. That is the price of relaxing it, and
// it is bounded: at the search interval roughly one cycle in four runs pose, and one stretched
// interval in four at the measured 23 + pose costs under a tenth of the detection rate. Worth it
// only while there is actually someone to find, which is why 'acquiring' does not relax it - it
// gets the fast object-detection tier and nothing more, because a track that exists does not need
// a second way to be found.
//
// 'lost' and 'motion' both do relax it, and for the same reason: each is a person the object
// detector is not finding, and the pose landmarker is the one thing in the app that finds a person
// the object detector missed ("a pose nowhere near any surviving object box", detector.js). Buying
// a pose pass is most of the point of the movement hint, which is why the hint is held open
// (frame-motion.js HINT_HOLD_MS) for longer than this interval.
function shouldUsePoseFallback(now, tier) {
  if (!state.poseDetector) return false;
  if (rosterCandidateCount() < 2) return false;
  const searching = tier === 'lost' || tier === 'motion';
  const interval = searching ? GAME_POSE_SEARCH_INTERVAL_MS : GAME_POSE_DETECT_INTERVAL_MS;
  return now - state.lastGamePoseDetectAt >= interval;
}

function detectGameplayPeople(source, timestamp, tier) {
  if (shouldUsePoseFallback(timestamp, tier)) {
    state.lastGamePoseDetectAt = timestamp;
    return detectTrackedPeople(state.detector, state.poseDetector, source, timestamp);
  }
  return detectTrackedPeopleFast(state.detector, source, timestamp);
}

// The movement look, once per detection cycle at most and inside the cycle's own timing.
//
// Two things about where this sits are deliberate. It runs on `source`, the same picture the
// object detector is about to be handed, so what moved is measured on what was looked at; and it
// is compared against the *previous* cycle's boxes and tracks, which is the most recent account of
// who has already been found - there is no answer for this cycle yet, and waiting for one would
// mean a second readback.
//
// It is also inside the t0..inferenceMs window on purpose. inferenceMs feeds the duty cap, so if
// the readback turns out to cost real time on some phone, that phone lengthens its own detection
// interval instead of quietly spending the FIRE button's share of the thread. The alternative -
// timing it separately so it looks free - would hide exactly the cost worth knowing about.
//
// `tier === 'lost'` skips it outright. That is the busiest state the loop has, and it is already
// running the fast cadence with pose relaxed, so there is no escalation left for movement to ask
// for and nothing a hint could change. Zero added cost in the state where the thread is most
// contended is the whole adaptivity claim here.
function sampleMotionHint(source, t0, scaleX, scaleY, tier) {
  if (tier === 'lost' || !frameMotionWorthSampling(t0)) return;
  // Into `source`'s coordinates, which is what frame-motion.js compares its cells against.
  const toSource = (boxes) => scaleBoxes(boxes, 1 / scaleX, 1 / scaleY);
  const live = state.tracks.filter((track) => isLiveTrack(track, t0)).map((track) => liveBox(track, t0));
  sampleFrameMotion(source, t0, { boxes: toSource(state.boxes), trackBoxes: toSource(live) });
}

function refreshGameDetection(tier = detectTier()) {
  if (state.mode !== 'game' || video.readyState < 2) return false;
  const t0 = performance.now();
  const { source, scaleX, scaleY } = gameplayInferenceSource();
  sampleMotionHint(source, t0, scaleX, scaleY, tier);
  state.boxes = scaleBoxes(detectGameplayPeople(source, t0, tier), scaleX, scaleY);
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
  if (DEBUG) countIdentifyChecks(t0);
  return true;
}

// Identification is throttled separately from detection (RECHECK_MS), so its achieved rate is its
// own number and cannot be read off the detection rate. Counted as a fraction of (live track,
// cycle) pairs that were a real check, which multiplied by the detection rate is the per-track
// identification Hz - what the player actually experiences as "how often does the name update".
// ?debug only; nothing here runs on a normal load.
function countIdentifyChecks(t0) {
  for (const track of state.tracks) {
    if (!isLiveTrack(track, t0)) continue;
    idTrackCycles++;
    if (track.lastCheck === t0) idChecks++;
  }
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

// A health bar: the fill, with a white chip behind it for HP just lost.
function createHealthBar(hp, maxHp) {
  const bar = document.createElement('div');
  bar.className = 'hp';
  bar.innerHTML = '<div class="hp-chip"></div><div class="hp-fill"></div>';
  bar.addEventListener('animationend', (event) => {
    if (event.target === bar) bar.classList.remove('hurt');
  });
  setHealth(bar, hp, maxHp);
  return bar;
}

// A drop snaps the fill down and gives the bar a small shake; the chip stays at the old HP for a
// moment and then drains to the new one (its delayed width transition is in style.css).
function setHealth(bar, hp, maxHp) {
  const previous = Number(bar.dataset.hp);
  const fraction = Math.max(0, hp / maxHp);
  bar.dataset.hp = hp;
  bar.querySelector('.hp-fill').style.width = `${fraction * 100}%`;
  bar.querySelector('.hp-fill').classList.toggle('low', fraction <= 0.3);
  bar.querySelector('.hp-chip').style.width = `${fraction * 100}%`;
  if (hp < previous) restartAnimation(bar, 'hurt');
}

export function renderHud() {
  const game = state.game;
  const hud = $('hud');
  // Rows are kept per player rather than rebuilt, so a bar's shake and drain survive the next
  // update, and only moved when the order changes: a node taken out of the page drops both.
  const rows = new Map([...hud.children].map((row) => [row.dataset.id, row]));
  // Yours always comes first, beside the Leave button; everyone else follows in join order.
  const players = [...(game?.players ?? [])].sort((a, b) => (b.id === state.myId) - (a.id === state.myId));
  players.forEach((p, i) => {
    let row = rows.get(String(p.id));
    rows.delete(String(p.id));
    if (!row) {
      row = document.createElement('div');
      row.dataset.id = p.id;
      row.append(document.createElement('div'), createHealthBar(p.hp, game.maxHp));
      row.firstChild.className = 'label';
    }
    row.className = `player${p.id === state.myId ? ' me' : ''}${!p.alive ? ' down' : ''}`;
    row.firstChild.innerHTML = `<span>${escapeHtml(p.name)}${p.id === state.myId ? ' (you)' : ''}${p.forfeited ? ' (left)' : ''}</span>${p.wins ? `<span class="wins">★${p.wins}</span>` : ''}`;
    setHealth(row.lastChild, p.hp, game.maxHp);
    if (hud.children[i] !== row) hud.insertBefore(row, hud.children[i] ?? null);
  });
  for (const row of rows.values()) row.remove();

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

// A hit shows the target's health bar above their head for a moment. drawGame() keeps it over
// them as they move, and it stays where it was last seen if their track drops out.
const hitBars = new Map(); // player id -> the bar's element

export function showHitBar(targetId, hp, damage) {
  const maxHp = state.game?.maxHp;
  if (targetId == null || hp == null || !maxHp) return;
  let el = hitBars.get(targetId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'hit-bar';
    // Starts at the HP before this hit, so the bar has something to drain from.
    el.append(createHealthBar(hp + damage, maxHp));
    el.addEventListener('animationend', (event) => {
      if (event.target !== el) return;
      el.remove();
      hitBars.delete(targetId);
    });
    $('hit-bars').append(el);
    hitBars.set(targetId, el);
    void el.offsetWidth; // style the old HP first, so the drop below transitions from it
  }
  setHealth(el.firstChild, hp, maxHp);
  restartAnimation(el, 'show');
}

export function clearHitBars() {
  hitBars.clear();
  $('hit-bars').replaceChildren();
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

// Head beats body; among equal zones, the nearest person, with the detector box's height standing
// in for distance. Strictly better, so an exact tie keeps whichever track came first and the choice
// does not flicker between two identically sized boxes from frame to frame.
const betterTarget = (a, b) => (a.zone === b.zone ? a.height > b.height : a.zone === 'head');

// Which (if any) valid target is under the crosshair, which zone, and who it is.
//
// Deterministic in a way the obvious loop was not. It used to `return` on the *first* track whose
// head box contained the crosshair, while letting each later body match overwrite the one before
// it - so a head hit was decided by the front of `state.tracks` and a body hit by the back, and
// with two overlapping valid targets who got shot depended on array order rather than on anything
// the player can see. Tap-anywhere firing and the relaxed range gate (identify.js) both make
// overlapping candidates ordinary rather than rare, so it is now one rule over every track:
// head before body, then nearest. That is what aiming at someone means - you shoot the person in
// front of the other one.
function targetUnderCrosshair(px, py) {
  if (state.game?.status !== 'playing') return null;
  const now = performance.now();
  let best = null;
  for (const t of state.tracks) {
    if (!isLiveTrack(t, now)) continue;
    const playerId = targetPlayerId(t, now);
    if (!playerId || !isAlivePlayer(playerId)) continue;
    const box = liveBox(t, now);
    const zone = contains(headBox(box), px, py) ? 'head' : contains(bodyBox(box), px, py) ? 'body' : null;
    if (!zone) continue;
    const candidate = { track: t, zone, playerId, height: box.h };
    if (!best || betterTarget(candidate, best)) best = candidate;
  }
  return best;
}

export function fire() {
  if (!canLocalPlayerFire()) return;
  const now = performance.now();
  if (now - state.lastShotAt < FIRE_COOLDOWN_MS) return;
  state.lastShotAt = now;
  sound.shoot();
  restartAnimation($('crosshair'), 'firing');
  $('cooldown').style.setProperty('--cooldown', `${FIRE_COOLDOWN_MS}ms`);
  restartAnimation($('cooldown'), 'cooling');

  // The crosshair is the centre of the screen, which is also the centre of the video
  // because the video is scaled with object-fit: cover around its centre.
  //
  // No detection is forced here, deliberately, and the reason is correctness before it is speed.
  // The shot must agree with the crosshair, and the crosshair is set by drawGame() from exactly
  // this call on the *previous* frame - from liveBox(), which projects each track along its
  // velocity. Forcing a fresh detection inside the shot would resolve it against data the player
  // never saw: they tapped because the crosshair went red, and a detection that runs afterwards
  // can move or lose that box. "What you see is what you hit" (liveBox) is the guarantee, and a
  // refresh here breaks it rather than protecting it. It also cost the shot a full synchronous
  // object detection - plus the pose model once two players were enrolled - on the one path in
  // the app where the player is waiting.
  const hit = targetUnderCrosshair(video.videoWidth / 2, video.videoHeight / 2);
  // A miss is posted too, with no target: the server counts every shot for your accuracy.
  postShot(hit?.playerId ?? null, hit?.zone ?? null);
}

async function postShot(targetId, zone) {
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
// Three rates, because they are three different things and the old single "fps" was read as
// whichever one the reader had in mind. All ?debug only.
//   drawFrames  animation frames, i.e. how smooth the overlay actually is. This is the one a
//               player means by "fps", and the one that says whether a detection is starving the
//               draw: the boxes are redrawn from liveBox() every frame, so this should stay near
//               the display rate however slowly detection runs.
//   frames      detections. What the old counter meant, and the number the cadence targets.
//   idChecks    identification checks, over idTrackCycles live-track-cycles. See
//               countIdentifyChecks.
let drawFrames = 0;
let drawFps = 0;
let idChecks = 0;
let idTrackCycles = 0;
let idHz = 0;

// `det 19/20 · id 9/10 Hz lost` - achieved against target for both rates, plus which cadence tier
// is asking, so a phone running slow says why. `det` is detections per second, never the screen
// frame rate: that is `draw`, printed separately, precisely because one number called "fps" got
// read as the other. A `det` well under target with `ms` over ~35 is the duty cap holding the rate
// down, which is correct behaviour and not a bug; a `det` at target with `id` under it means
// identification is being throttled by RECHECK_MS rather than by the loop.
function rateLine(now) {
  const tier = detectTier(now);
  const id = idTrackCycles || idHz ? `${idHz.toFixed(0)}/${ID_TARGET_HZ} Hz` : `-/${ID_TARGET_HZ} Hz`;
  return `det ${fps.toFixed(0)}/${DETECT_TARGET_FPS} · id ${id}${tier ? ` ${tier}` : ''}`;
}

export function loop() {
  requestAnimationFrame(loop);

  if (!state.postProcessingScan && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    if (state.mode === 'scan') {
      refreshScanPreview();
    } else if (state.mode === 'game') {
      const now = performance.now();
      const tier = detectTier(now);
      if (now - state.lastGameDetectAt >= gameDetectInterval(now, tier)) refreshGameDetection(tier);
    }
  }

  draw();
  if (state.mode === 'game') updateCountdown();

  if (DEBUG) {
    const now = performance.now();
    drawFrames++;
    if (now - fpsWindowStart >= 1000) {
      const seconds = (now - fpsWindowStart) / 1000;
      fps = frames / seconds;
      drawFps = drawFrames / seconds;
      // Checks per live track per second: the share of track-cycles that were a real check, at the
      // rate those cycles happened. 0 when nothing was on screen, which prints as `-`.
      idHz = idTrackCycles ? (idChecks / idTrackCycles) * fps : 0;
      frames = 0;
      drawFrames = 0;
      idChecks = 0;
      idTrackCycles = 0;
      fpsWindowStart = now;
    }
    const visibleTracks = state.tracks.filter((t) => isLiveTrack(t, now));
    const identified = visibleTracks.filter((t) => t.playerId && t.playerId !== localSelfId());
    const rejected = visibleTracks.filter((t) => !t.playerId && t.debugMatch);
    const ranked = visibleTracks.filter((t) => t.rankings?.length);
    const rankName = (rank) => (rank.id === localSelfId() ? 'self' : rank.name);
    $('debug').textContent =
      `${state.delegate} · draw ${drawFps.toFixed(0)} fps · ${rateLine(now)} · ${inferenceMs.toFixed(0)} ms · reid ≥ ${getReidThreshold().toFixed(2)}\n` +
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
        : '') +
      // Startup and scan costs: both are one-off, so they are appended rather than recomputed,
      // and both are empty until the thing they measure has happened.
      (startupTimingLine() ? `\n${startupTimingLine()}` : '') +
      (scanCostLine() ? `\n${scanCostLine()}` : '');
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
  const seen = new Map(); // player id -> their box on screen, for the hit bars
  for (const track of state.tracks) {
    if (!isLiveTrack(track, now)) continue;
    // Who this is, if the appearance gate is confident: a rejected guess shows as a person.
    const playerId = targetPlayerId(track, now);
    const known = playerId !== null;
    const dead = known && isDeadPlayer(playerId);
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

    const [x, y, w] = toScreen(box);
    // `box` is liveBox(), not track.box, for the same reason the crosshair and the shot use it:
    // the hit bar has to sit on the box the player is actually looking at this frame.
    if (known) seen.set(playerId, { x: x + w / 2, y });
    ctx.fillStyle = color;
    ctx.setLineDash([]);
    // In debug mode every box also shows its best match and score, for tuning ?reid= in the field.
    const best = DEBUG ? (track.rankings ?? []).find((r) => r.id !== localSelfId()) : null;
    // The typical (median) score, with this check's own in brackets when it differs.
    const latestNote = best?.rawScore != null && Math.abs(best.rawScore - best.score) >= 0.005 ? ` (now ${best.rawScore.toFixed(2)})` : '';
    const scoreNote = best ? ` [${best.name} ${best.score.toFixed(2)}${latestNote}${best.hasReid ? '' : ' colour'}]` : '';
    const label = (known
      ? `${track.name}${dead ? ' down' : ''}`
      : debugMatch
        ? `${debugMatch.name}? ${debugMatch.score.toFixed(2)}`
        : 'Person') + scoreNote;
    ctx.fillText(label, x + 4, y + 16);
  }

  // Kept on screen, below the scoreboard, when their head is above the top of the frame.
  const minTop = hitBars.size ? $('hud').offsetHeight + 16 : 0;
  for (const [playerId, el] of hitBars) {
    const at = seen.get(playerId);
    if (!at) continue;
    el.style.left = `${at.x}px`;
    el.style.top = `${Math.max(at.y, minTop)}px`;
  }
}
