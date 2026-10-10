// Entry point: connect the page's form, buttons and keys to the screens, then hand over.
//
// Everything that does any work lives in the modules imported below - env.js for the shared
// elements, state.js for the one state object, a module per screen - so this file stays a wiring
// diagram you can read in one go. The only thing it starts by itself is the attempt to resume a
// lobby a refresh interrupted.

import { $ } from './env.js';
import { keepScreenOn } from './camera.js';
import { identity } from './identity.js';
import { send } from './net.js';
import { state } from './state.js';
import * as sound from './sound.js';
import { enterLobbyFromForm, initJoinForm, resumeActiveLobby, setJoinStatus } from './screens/join.js';
import { launchGame, leaveLobby } from './screens/lobby.js';
import { cancelScan } from './screens/scan.js';
import { closeLeaveDialog, fire, openLeaveDialog } from './screens/game.js';

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

// A tap anywhere on the game screen fires, except on its buttons (Leave, Start) and the leave dialog.
$('game-screen').addEventListener('pointerdown', (event) => {
  if (event.target.closest('button, dialog') || $('leave-dialog').open) return;
  event.preventDefault();
  identity.start(); // in case a sensor was never granted at join, or there was no join tap
  fire();
});
// Clears both, so a lingering `hit` never masks the next `firing` (or the other way round).
$('crosshair').addEventListener('animationend', () => $('crosshair').classList.remove('firing', 'hit'));
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

resumeActiveLobby();
