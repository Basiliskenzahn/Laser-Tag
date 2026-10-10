// The first screen: a name, a room code, and everything that has to succeed before the lobby.
//
// Submitting it starts the camera and loads the models (camera.js), which is slow and can fail
// for reasons the player can fix, so this screen doubles as the status line for those errors. It
// also restores the lobby an accidental reload interrupted, deliberately through the same path as
// a manual join so there is only one way into the lobby. showJoinRejected() is the way back here
// when the server turns the player away.

import { DEBUG, canvas, params, video, $ } from '../env.js';
import { keepScreenOn, prepareCameraAndDetector, startupErrorMessage, stopCamera } from '../camera.js';
import { clearActiveLobby, load, loadActiveLobby, save, state } from '../state.js';
import { connect, showConnectionProblem } from '../net.js';
import { clearGameCountdown, loop } from './game.js';
import { renderLobby } from './lobby.js';
import { hideScanCountdown, loadScanCache } from './scan.js';

export function initJoinForm() {
  $('name').value = load('name') ?? '';
  $('room').value = params.get('room') ?? load('room') ?? 'demo';
}

export async function enterLobbyFromForm({ resumePlayerId = null, auto = false } = {}) {
  state.name = $('name').value.trim();
  state.room = $('room').value.trim().toLowerCase();
  state.resumePlayerId = resumePlayerId;
  state.localGallery = [];
  state.gallery = [];
  state.scanThumbs = [];
  state.scanTargetId = null;
  state.scanTargetName = '';
  state.savedScan = loadScanCache();
  if (state.savedScan?.gallery?.length) state.localGallery = state.savedScan.gallery;
  save('name', state.name);
  save('room', state.room);

  if (!state.name || !state.room) return;
  $('join-btn').hidden = false;
  $('join-btn').disabled = true;
  setJoinStatus(auto ? 'Rejoining lobby...' : 'Starting camera and loading the detector...');
  try {
    await prepareCameraAndDetector();
  } catch (err) {
    console.error(err);
    setJoinStatus(startupErrorMessage(err));
    $('join-btn').disabled = false;
    return;
  }

  video.hidden = true;
  canvas.hidden = true;
  $('join-screen').hidden = true;
  $('lobby-screen').hidden = false;
  $('debug').hidden = !DEBUG;
  keepScreenOn();
  state.mode = 'lobby';
  renderLobby();
  if (!state.loopStarted) {
    state.loopStarted = true;
    requestAnimationFrame(loop);
  }
  connect();
}

export function setJoinStatus(text) {
  $('join-status').textContent = text;
}

export function showJoinRejected(message) {
  state.conn?.close();
  state.conn = null;
  state.events?.close();
  state.events = null;
  clearActiveLobby();
  stopCamera();
  hideScanCountdown();
  clearGameCountdown();
  state.mode = 'join';
  state.game = null;
  state.myId = null;
  $('join-screen').hidden = false;
  $('lobby-screen').hidden = true;
  $('scan-screen').hidden = true;
  $('game-screen').hidden = true;
  video.hidden = true;
  canvas.hidden = true;
  $('join-btn').disabled = false;
  $('join-btn').hidden = true;
  setJoinStatus(message);
  showConnectionProblem(null);
}

export function resumeActiveLobby() {
  const lobby = loadActiveLobby();
  if (!lobby) return;
  $('name').value = lobby.name;
  $('room').value = lobby.room;
  enterLobbyFromForm({ resumePlayerId: lobby.playerId, auto: true });
}
