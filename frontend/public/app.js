// Entry point: connect the page's form, buttons and keys to the screens, then hand over.
//
// Everything that does any work lives in the modules imported below - env.js for the shared
// elements, state.js for the one state object, a module per screen - so this file stays a wiring
// diagram you can read in one go. The only thing it starts by itself is the attempt to resume a
// lobby a refresh interrupted.

import { $, REID_THRESHOLD } from './env.js';
import { setReidThreshold } from './identify.js';
import { keepScreenOn } from './camera.js';
import { identity } from './identity.js';
import { send } from './net.js';
import { state } from './state.js';
import * as sound from './sound.js';
import { enterLobbyFromForm, initJoinForm, resumeActiveLobby, setJoinStatus } from './screens/join.js';
import { launchGame, leaveLobby } from './screens/lobby.js';
import { cancelScan } from './screens/scan.js';
import { fire } from './screens/game.js';

if (REID_THRESHOLD != null) setReidThreshold(REID_THRESHOLD); // ?reid=0.70, for tuning in the field

// ---- Join screen ----

initJoinForm();

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
  identity.start(); // inside the tap: the only place iOS will prompt for a sensor
  enterLobbyFromForm();
});

document.addEventListener('visibilitychange', () => {
  // The browser releases the wake lock whenever the page is hidden.
  if (document.visibilityState === 'visible' && state.detector) keepScreenOn();
});

// ---- Lobby screen ----

$('launch-btn').addEventListener('click', launchGame);
$('leave-lobby-btn').addEventListener('click', leaveLobby);

// ---- Scan screen ----

$('scan-cancel-btn').addEventListener('click', cancelScan);

// ---- Game screen ----

$('start-btn').addEventListener('click', () => send({ type: 'start' }));

// `pointerdown`, not `click`: no 300 ms tap delay, and the shot goes out on finger-down. The
// event's `timeStamp` is handed on because it is when the *browser* created the tap, not when
// this listener got to run - the difference is how long the tap waited for the main thread, which
// is the only thing that can measure the reported input lag. ?debug prints it; see
// frontend/public/input-latency.js.
$('fire-btn').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  identity.start(); // in case a sensor was never granted at join, or there was no join tap
  fire(event.timeStamp);
});
$('fire-btn').addEventListener('animationend', () => $('fire-btn').classList.remove('firing'));
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !$('game-screen').hidden) fire(event.timeStamp);
});

resumeActiveLobby();
