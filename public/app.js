import { createDetector, detectPeople, headBox, contains } from './detector.js';
import { extractSignature, Tracker } from './identify.js';
import * as sound from './sound.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const FIRE_COOLDOWN_MS = 350;

const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

// Face the camera, then rotate - so enrolment has a sample from every side a shooter might see.
const SCAN_STEPS = [
  'Stand where your whole body is visible, then face the camera.',
  'Turn to show your right side.',
  'Turn around - show your back.',
  'Turn to show your left side.',
];

const state = {
  name: '',
  room: '',
  ws: null,
  myId: null,
  game: null, // latest state snapshot from the server (hp, status, ...)
  roster: [], // latest roster from the server (id, name, gallery)
  detector: null,
  delegate: '',
  mode: 'scan', // 'scan' | 'game' - which screen the shared camera loop renders for
  boxes: [], // people in the latest camera frame, in video pixels
  tracker: new Tracker(),
  tracks: [],
  gallery: [], // signatures captured so far during enrolment
  scanDone: false, // the join message (with the gallery) is only sent once scanning is finished
  failedConnects: 0, // connection attempts in a row that never opened
  lastShotAt: 0,
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
  save('name', state.name);
  save('room', state.room);

  // Everything that needs a user gesture happens here.
  sound.unlock();
  $('join-btn').disabled = true;
  setJoinStatus('Starting camera and loading the detector…');
  try {
    const [, { detector, delegate }] = await Promise.all([startCamera(), createDetector()]);
    state.detector = detector;
    state.delegate = delegate;
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
  startScanStep(0);
  requestAnimationFrame(loop);
  // Connect now rather than after scanning, so a server that can't be reached shows up
  // straight away instead of after the player has scanned all four sides.
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

function startScanStep(i) {
  $('scan-instruction').textContent = SCAN_STEPS[i] ?? '';
  $('scan-capture-btn').hidden = i >= SCAN_STEPS.length;
  $('scan-join-btn').hidden = i < SCAN_STEPS.length;
}

function biggestBox(boxes) {
  return boxes.reduce((best, b) => (!best || b.w * b.h > best.w * best.h ? b : best), null);
}

function cropThumbnail(box) {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 64;
  c.getContext('2d').drawImage(video, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

$('scan-capture-btn').addEventListener('click', () => {
  const box = biggestBox(state.boxes);
  if (!box) {
    $('scan-instruction').textContent = `${SCAN_STEPS[state.gallery.length]} (no one detected - step back a little)`;
    return;
  }
  state.gallery.push(extractSignature(video, box));

  const thumb = document.createElement('img');
  thumb.src = cropThumbnail(box);
  thumb.title = 'Tap to redo this and later angles';
  thumb.addEventListener('click', () => {
    const i = [...$('scan-thumbs').children].indexOf(thumb);
    state.gallery.length = i;
    [...$('scan-thumbs').children].slice(i).forEach((el) => el.remove());
    startScanStep(i);
  });
  $('scan-thumbs').append(thumb);
  startScanStep(state.gallery.length);
});

$('scan-join-btn').addEventListener('click', () => {
  $('scan-screen').hidden = true;
  $('game-screen').hidden = false;
  state.mode = 'game';
  state.scanDone = true;
  sendJoin(); // if the socket isn't open yet, onopen sends it
  renderHud();
});

// ---- Networking ----

// Shown when the socket keeps failing before it ever opens. The usual cause is a phone browser
// (iPhone Safari especially) that let the player past the self-signed certificate warning for
// the page, but still silently refuses the WebSocket to the same address.
const UNREACHABLE_MESSAGE =
  "Can't connect to the game server. If you opened the self-signed https:// address, your browser " +
  'may be blocking the game connection: use the trusted https:// link instead (see the README). Still retrying…';

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let opened = false;
  state.ws = ws;
  ws.onopen = () => {
    opened = true;
    state.failedConnects = 0;
    showConnectionProblem(null);
    sendJoin();
  };
  ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.game = null;
    if (!opened) state.failedConnects++;
    showConnectionProblem(state.failedConnects >= 2 ? UNREACHABLE_MESSAGE : 'Connection lost. Reconnecting…');
    setTimeout(connect, 1500);
  };
}

function sendJoin() {
  if (state.scanDone) send({ type: 'join', name: state.name, room: state.room, gallery: state.gallery });
}

// Connection problems go on whichever screen is showing: the scan panel or the game banner.
function showConnectionProblem(text) {
  $('scan-connection').textContent = text ?? '';
  $('scan-connection').hidden = !text || state.mode !== 'scan';
  state.bannerOverride = text;
  renderHud();
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
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
  text.classList.remove('big');
  if (state.bannerOverride) text.textContent = state.bannerOverride;
  else if (!game) text.textContent = 'Connecting…';
  else if (game.status === 'waiting') {
    text.textContent =
      game.players.length < game.minPlayers
        ? `Waiting for more players… Room code: ${game.code} (${game.players.length}/${game.minPlayers})`
        : `Ready - room code: ${game.code}`;
  } else if (game.status === 'over') {
    text.textContent = game.winner === state.myId ? 'You win!' : 'You got tagged!';
  } else {
    text.textContent = ''; // countdown is drawn every frame in loop()
  }
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

// Which (if any) tracked person is under the crosshair, and which zone of them.
function targetUnderCrosshair(px, py) {
  let bodyTrack = null;
  for (const t of state.tracks) {
    if (!contains(t.box, px, py)) continue;
    if (contains(headBox(t.box), px, py)) return { track: t, zone: 'head' };
    bodyTrack = t;
  }
  return bodyTrack ? { track: bodyTrack, zone: 'body' } : null;
}

function fire() {
  const now = performance.now();
  if (now - state.lastShotAt < FIRE_COOLDOWN_MS) return;
  state.lastShotAt = now;
  sound.shoot();
  restartAnimation($('fire-btn'), 'firing');

  // The crosshair is the centre of the screen, which is also the centre of the video
  // because the video is scaled with object-fit: cover around its centre.
  const hit = targetUnderCrosshair(video.videoWidth / 2, video.videoHeight / 2);
  if (hit?.track.playerId && state.game?.status === 'playing') {
    send({ type: 'shoot', targetId: hit.track.playerId, zone: hit.zone });
  }
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

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const t0 = performance.now();
    state.boxes = detectPeople(state.detector, video, t0);
    if (state.mode === 'game') {
      state.tracks = state.tracker.update(state.boxes, video, state.roster, state.myId, t0);
    }
    inferenceMs = performance.now() - t0;
    frames++;
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
    $('debug').textContent =
      `${state.delegate} · ${fps.toFixed(0)} fps · ${inferenceMs.toFixed(0)} ms\n` +
      `${video.videoWidth}×${video.videoHeight} · ${state.boxes.length} people` +
      (state.mode === 'game' ? ` · ${state.tracks.filter((t) => t.playerId).length} identified` : '');
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
  const target = biggestBox(state.boxes);
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
  for (const track of state.tracks) {
    const targeted = hit?.track === track;
    const known = track.playerId !== null;
    const color = targeted ? '#ff2e4d' : known ? '#39ff88' : '#8a97a6';
    ctx.strokeStyle = color;
    ctx.setLineDash(known ? [] : [4, 4]);
    ctx.strokeRect(...toScreen(track.box));

    ctx.setLineDash([6, 4]);
    ctx.strokeRect(...toScreen(headBox(track.box)));

    const [x, y] = toScreen(track.box);
    ctx.fillStyle = color;
    ctx.setLineDash([]);
    ctx.fillText(track.name ?? 'unknown', x + 4, y + 16);
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
