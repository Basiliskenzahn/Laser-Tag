import { createDetector, detectPeople, headBox, hitTest } from './detector.js';
import * as sound from './sound.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const FIRE_COOLDOWN_MS = 350;

const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

const state = {
  name: '',
  room: '',
  ws: null,
  myId: null,
  game: null, // latest snapshot from the server
  detector: null,
  delegate: '',
  boxes: [], // people in the latest camera frame, in video pixels
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

  $('join-screen').hidden = true;
  $('game-screen').hidden = false;
  $('debug').hidden = !DEBUG;
  keepScreenOn();
  connect();
  requestAnimationFrame(loop);
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

// ---- Networking ----

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => send({ type: 'join', name: state.name, room: state.room });
  ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.game = null;
    state.bannerOverride = 'Connection lost. Reconnecting…';
    renderHud();
    setTimeout(connect, 1500);
  };
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
      state.bannerOverride = msg.message === 'Room is full'
        ? `Room "${state.room}" already has two players. Reload and pick another code.`
        : msg.message;
      renderHud();
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
  const me = game?.players.find((p) => p.id === state.myId);
  const opponent = game?.players.find((p) => p.id !== state.myId);

  renderPlayer('me', me, game?.maxHp);
  renderPlayer('opp', opponent, game?.maxHp);

  const over = game?.status === 'over';
  $('rematch-btn').hidden = !over;
  const text = $('banner-text');
  text.classList.remove('big');
  if (state.bannerOverride) text.textContent = state.bannerOverride;
  else if (!game) text.textContent = 'Connecting…';
  else if (game.status === 'waiting') text.textContent = `Waiting for an opponent… Room code: ${game.code}`;
  else if (over) text.textContent = game.winner === state.myId ? 'You win!' : 'You got tagged!';
  else text.textContent = ''; // countdown is drawn every frame in loop()
}

function renderPlayer(prefix, player, maxHp) {
  $(`${prefix}-name`).textContent = player?.name ?? (prefix === 'me' ? state.name : 'Waiting…');
  $(`${prefix}-wins`).textContent = player?.wins ? `★${player.wins}` : '';
  const fraction = player ? player.hp / maxHp : 1;
  const fill = $(`${prefix}-hp`);
  fill.style.width = `${fraction * 100}%`;
  fill.classList.toggle('low', fraction <= 0.3);
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

// ---- Shooting ----

function fire() {
  const now = performance.now();
  if (now - state.lastShotAt < FIRE_COOLDOWN_MS) return;
  state.lastShotAt = now;
  sound.shoot();
  restartAnimation($('fire-btn'), 'firing');

  // The crosshair is the centre of the screen, which is also the centre of the video
  // because the video is scaled with object-fit: cover around its centre.
  const zone = hitTest(state.boxes, video.videoWidth / 2, video.videoHeight / 2);
  if (zone && state.game?.status === 'playing') send({ type: 'shoot', zone });
}

$('fire-btn').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  fire();
});
$('fire-btn').addEventListener('animationend', () => $('fire-btn').classList.remove('firing'));
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !$('game-screen').hidden) fire();
});
$('rematch-btn').addEventListener('click', () => send({ type: 'rematch' }));

// ---- Detection and drawing loop ----

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
    inferenceMs = performance.now() - t0;
    frames++;
  }

  draw();
  updateCountdown();

  if (DEBUG) {
    const now = performance.now();
    if (now - fpsWindowStart >= 1000) {
      fps = (frames * 1000) / (now - fpsWindowStart);
      frames = 0;
      fpsWindowStart = now;
    }
    $('debug').textContent =
      `${state.delegate} · ${fps.toFixed(0)} fps · ${inferenceMs.toFixed(0)} ms\n` +
      `${video.videoWidth}×${video.videoHeight} · ${state.boxes.length} people`;
  }
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  // Same mapping as object-fit: cover, from video pixels to screen pixels.
  const scale = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * scale) / 2;
  const oy = (ch - vh * scale) / 2;
  const toScreen = (b) => [ox + b.x * scale, oy + b.y * scale, b.w * scale, b.h * scale];

  const cx = vw / 2;
  const cy = vh / 2;
  const zone = hitTest(state.boxes, cx, cy);
  $('crosshair').classList.toggle('on-target', zone !== null);

  ctx.lineWidth = 3;
  ctx.font = '600 13px system-ui, sans-serif';
  for (const box of state.boxes) {
    const targeted = hitTest([box], cx, cy) !== null;
    const color = targeted ? '#ff2e4d' : '#39ff88';
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    ctx.strokeRect(...toScreen(box));

    ctx.setLineDash([6, 4]);
    ctx.strokeRect(...toScreen(headBox(box)));

    const [x, y] = toScreen(box);
    ctx.fillStyle = color;
    ctx.fillText(`${Math.round(box.score * 100)}%`, x + 4, y + 16);
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
