// Entry point: connect the page's form, buttons and keys to the screens, then hand over.
//
// Everything that does any work lives in the modules imported below - env.js for the shared
// elements, state.js for the one state object, a module per screen - so this file stays a wiring
// diagram you can read in one go.

import { $, REID_THRESHOLD } from './env.js';
import { setReidThreshold } from './identify.js';
import { keepScreenOn, resumeCamera } from './camera.js';
import { startMotion } from './motion/index.js';
import { send } from './net.js';
import { state } from './state.js';
import * as sound from './sound.js';
import {
  enterLobby,
  generateRoomCode,
  initJoinForm,
  normalizeRoomCode,
  requireName,
  setJoinStatus,
  updateJoinButton,
} from './screens/join.js';
import { copyRoomCode, launchGame, leaveLobby, showLobby } from './screens/lobby.js';
import { cancelScan } from './screens/scan.js';
import { closeLeaveDialog, fire, openLeaveDialog } from './screens/game.js';
import { rematch } from './screens/results.js';

if (REID_THRESHOLD != null) setReidThreshold(REID_THRESHOLD); // ?reid=0.70, for tuning in the field

// ---- Title screen ----

initJoinForm();

$('name').addEventListener('input', () => setJoinStatus(''));

// Both ways in start from a tap, which is the only place iOS will prompt for a sensor. A no-op
// without ?motion=. `send` is handed over rather than imported by motion/ so that target.js,
// which consults motion every frame, does not drag net.js's import graph in behind it.
function enterRoom(room) {
  sound.unlock();
  startMotion(send);
  enterLobby({ room });
}

$('create-room-btn').addEventListener('click', () => {
  if (requireName()) enterRoom(generateRoomCode());
});

$('join-room-btn').addEventListener('click', () => {
  if (!requireName()) return;
  $('join-dialog').showModal();
  $('room-code').focus();
});
$('room-code').addEventListener('input', () => {
  $('room-code').value = normalizeRoomCode($('room-code').value);
  updateJoinButton();
});
$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if ($('join-btn').disabled) return;
  $('join-dialog').close();
  enterRoom($('room-code').value);
});
$('join-cancel-btn').addEventListener('click', () => $('join-dialog').close());

$('how-to-play-btn').addEventListener('click', () => $('rules-dialog').showModal());
$('rules-close-btn').addEventListener('click', () => $('rules-dialog').close());

// A tap on the backdrop (the dialog element itself, outside its box) closes any pop-up.
for (const id of ['join-dialog', 'rules-dialog']) {
  $(id).addEventListener('click', (event) => {
    if (event.target === event.currentTarget) $(id).close();
  });
}

// Every later tap unlocks too: iOS suspends the audio context again when the camera starts and
// when the page is hidden. touchend, not pointerdown, because that is what counts as a gesture.
for (const type of ['touchend', 'click', 'keydown']) document.addEventListener(type, sound.unlock);

// Coming back from the background. resumeCamera() gives a live stream 1.2 s to produce a new
// frame and otherwise stops it and asks for a fresh one, which is right for a stream the OS has
// quietly ended - and wrong while the first start is still in flight: `video.srcObject` is set
// before the models have finished, the main thread spends that window compiling shaders and WASM
// kernels, and a frame that misses the deadline for that reason would have the resume tear down
// the stream startLobby is waiting on and prompt the phone for the camera a second time. So it is
// gated on `startingLobby`, which latches for exactly that wait (screens/join.js).
function resumeCameraIfStarted() {
  if (!state.startingLobby) resumeCamera();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // The browser releases the wake lock whenever the page is hidden.
  if (state.detector) keepScreenOn();
  resumeCameraIfStarted();
});
// A page restored from the back/forward cache comes back with its camera stopped too.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) resumeCameraIfStarted();
});

// ---- Lobby screen ----

$('launch-btn').addEventListener('click', launchGame);
$('leave-lobby-btn').addEventListener('click', leaveLobby);
$('copy-room-btn').addEventListener('click', copyRoomCode);

// ---- Scan screen ----

$('scan-cancel-btn').addEventListener('click', cancelScan);

// ---- Game screen ----

$('start-btn').addEventListener('click', () => send({ type: 'start' }));

// A tap anywhere on the game screen fires, except on its buttons (Leave, Start) and the leave
// dialog. `pointerdown`, not `click`: no 300 ms tap delay, and the shot goes out on finger-down.
// #debug is not excluded here because it is no longer inside #game-screen (it is the last child
// of <body>) and is `pointer-events: none` besides, so a tap over it reaches the screen below and
// fires, which is what a player aiming through the overlay expects.
$('game-screen').addEventListener('pointerdown', (event) => {
  if (event.target.closest('button, dialog') || $('leave-dialog').open) return;
  event.preventDefault();
  fire();
  // In case a sensor was never granted at join, or there was no join tap (an automatic rejoin).
  // AFTER fire(), not before: this listener is the measured input path, and the previous version
  // of this subsystem sat ahead of the shot on it. It is still inside the gesture, so iOS will
  // still show the prompt.
  startMotion(send);
});
// Rapid taps (firing) still read as a double-tap zoom on some iPhones despite touch-action, so
// the camera screens cancel the touchend. Nothing there but the buttons needs the click it makes.
for (const id of ['game-screen', 'scan-screen']) {
  $(id).addEventListener(
    'touchend',
    (event) => {
      if (!event.target.closest('button, dialog')) event.preventDefault();
    },
    { passive: false },
  );
}
// Clears both, so a lingering `hit` never masks the next `firing` (or the other way round).
$('crosshair').addEventListener('animationend', () => $('crosshair').classList.remove('firing', 'hit'));
$('damage').addEventListener('animationend', () => $('damage').classList.remove('flash'));
$('cooldown').addEventListener('animationend', () => $('cooldown').classList.remove('cooling'));
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !$('game-screen').hidden && !$('leave-dialog').open) fire();
});

// Leaving asks first. Esc, "Stay" and a tap outside the box all cancel.
$('leave-game-btn').addEventListener('click', openLeaveDialog);
$('leave-cancel-btn').addEventListener('click', closeLeaveDialog);
$('leave-confirm-btn').addEventListener('click', leaveLobby);
$('leave-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeLeaveDialog(); // the backdrop, not the box
});

// ---- Results ----

$('results-done-btn').addEventListener('click', () => showLobby());
$('results-rematch-btn').addEventListener('click', rematch);
