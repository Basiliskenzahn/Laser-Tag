// Entry point: connect the page's form, buttons and keys to the screens, then hand over.
//
// Everything that does any work lives in the modules imported below - env.js for the shared
// elements, state.js for the one state object, a module per screen - so this file stays a wiring
// diagram you can read in one go. The only thing it starts by itself is the attempt to resume a
// lobby a refresh interrupted.

import { $ } from './env.js';
import { keepScreenOn } from './camera.js';
import { startMotion } from './motion-identity.js';
import { send } from './net.js';
import { state } from './state.js';
import * as sound from './sound.js';
import { enterLobbyFromForm, initJoinForm, resumeActiveLobby, setJoinStatus } from './screens/join.js';
import { launchGame, leaveLobby } from './screens/lobby.js';
import { cancelScan } from './screens/scan.js';
import { fire } from './screens/game.js';

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
  startMotion(); // no-op unless ?motion=on or ?motion=strict is set
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

$('fire-btn').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  startMotion(); // in case motion is enabled but wasn't granted at join
  fire();
});
$('fire-btn').addEventListener('animationend', () => $('fire-btn').classList.remove('firing'));
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !$('game-screen').hidden) fire();
});

resumeActiveLobby();
