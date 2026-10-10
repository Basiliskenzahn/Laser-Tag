// The title screen: a name, then Create Room, Join Room (a pop-up asking for the code) or How to
// Play, and everything that has to succeed before the lobby.
//
// Entering a room starts the camera and loads the models (camera.js), which is slow and can fail
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

export const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function initJoinForm() {
  $('name').value = load('name') ?? '';
  // A shared link (?room=ABC123) fills in the Join pop-up.
  $('room-code').value = normalizeRoomCode(params.get('room') ?? '');
  updateJoinButton();
}

// What a typed or pasted code becomes: uppercase letters and digits only, at most six of them, so
// "abc-123" or " ABC123 " from a message both work.
export function normalizeRoomCode(text) {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function updateJoinButton() {
  $('join-btn').disabled = $('room-code').value.length !== ROOM_CODE_LENGTH;
}

export function generateRoomCode() {
  const code = [];
  const bytes = new Uint8Array(1);
  while (code.length < ROOM_CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    // 252 is the largest multiple of 36 under 256; anything above would favour the first letters.
    if (bytes[0] < 252) code.push(ROOM_CODE_CHARS[bytes[0] % ROOM_CODE_CHARS.length]);
  }
  return code.join('');
}

// Both ways into a room need a name first, so this runs on the tap, before any pop-up opens.
export function requireName() {
  if ($('name').value.trim()) return true;
  setJoinStatus('Enter your name first.');
  $('name').focus();
  return false;
}

// Keeps the title screen from starting a second join while the camera and models load.
export function setTitleBusy(busy) {
  for (const id of ['name', 'create-room-btn', 'join-room-btn']) $(id).disabled = busy;
}

// The server treats codes case-insensitively and keys rooms in lowercase, so that is what is
// stored and sent; the screens show it in uppercase.
export async function enterLobby({ room, resumePlayerId = null, auto = false }) {
  state.name = $('name').value.trim();
  state.room = room.trim().toLowerCase();
  state.resumePlayerId = resumePlayerId;
  state.localGallery = [];
  state.gallery = [];
  state.scanThumbs = [];
  state.scanTargetId = null;
  state.scanTargetName = '';
  state.savedScan = loadScanCache();
  if (state.savedScan?.gallery?.length) state.localGallery = state.savedScan.gallery;
  save('name', state.name);

  if (!state.name || !state.room) return;
  setTitleBusy(true);
  setJoinStatus(auto ? 'Rejoining lobby...' : 'Starting camera and loading the detector...');
  try {
    await prepareCameraAndDetector();
  } catch (err) {
    console.error(err);
    setJoinStatus(startupErrorMessage(err));
    setTitleBusy(false);
    return;
  }

  video.hidden = true;
  canvas.hidden = true;
  $('join-screen').hidden = true;
  $('lobby-screen').hidden = false;
  setTitleBusy(false);
  setJoinStatus('');
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
  setTitleBusy(false);
  setJoinStatus(message);
  showConnectionProblem(null);
}

export function resumeActiveLobby() {
  const lobby = loadActiveLobby();
  if (!lobby) return;
  $('name').value = lobby.name;
  enterLobby({ room: lobby.room, resumePlayerId: lobby.playerId, auto: true });
}
