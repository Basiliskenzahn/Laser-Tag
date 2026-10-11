// The title screen: a name, then Create Room, Join Room (a pop-up asking for the code) or How to
// Play, and everything that has to succeed before the lobby.
//
// Entering a room starts the camera and loads the models (camera.js), which is slow and can fail
// for reasons the player can fix, so this screen doubles as the status line for those errors.
// showJoinRejected() is the way back here when the server turns the player away.
//
// What this screen waits for is the whole reason it is not slow any more. It used to await every
// model and only then dial the room, so the player sat on the title screen for 17.1 MB of models -
// two thirds of which detector.js has always described as optional - and then waited again for
// the roster to arrive before the lobby had anything in it. Both of those are now overlapped with
// the wait instead of queued behind it: the room is dialled first, because it is network I/O with
// nothing to do with the models, and the lobby opens on camera + object detector alone (startup.js
// explains the split). The roster is normally already in `state` by the time the lobby appears.

import { DEBUG, canvas, params, video, $ } from '../env.js';
import { keepScreenOn, prepareCameraAndDetector, startupErrorMessage, stopCamera } from '../camera.js';
import { markLobbyVisible } from '../startup.js';
import { load, save, state } from '../state.js';
import { connect, leaveRoom, showConnectionProblem } from '../net.js';
import { clearGameCountdown, enterGame, loop } from './game.js';
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

// `startingLobby` latches for the whole of the camera/model wait, and `if (state.startingLobby)
// return` below is the only thing standing between the player and two connections polling one
// room. That makes a throw anywhere in startLobby() worse than the error it came from: the flag
// would stay set and the title screen would be permanently inert, with nothing on screen to say
// why. Nothing in there is known to throw - the camera step, the one part that does, has its own
// catch - so this is hardening rather than a fix for a reproduced crash. It also means the
// callers (app.js's Create Room and Join) cannot leave an unhandled rejection: this function
// never rejects.
export async function enterLobby(options) {
  if (state.startingLobby) return;
  try {
    await startLobby(options);
  } catch (err) {
    console.error(err);
    abandonJoin('Could not start the lobby. Try again.');
  }
}

// The server treats codes case-insensitively and keys rooms in lowercase, so that is what is
// stored and sent; the screens show it in uppercase.
async function startLobby({ room }) {
  // Two joins at once would leave an orphaned connection polling the room, which matters now that
  // the connection is opened before the wait rather than after it. `startingLobby` doubles as
  // "this attempt is still the live one": showJoinRejected clears it, so an attempt whose room
  // turned it away below cannot go on to unhide the lobby when its models finally arrive.
  // (enterLobby above is what rejects a second attempt; by here we are the live one.)
  state.name = $('name').value.trim();
  state.room = room.trim().toLowerCase();
  state.resumePlayerId = null;
  state.localGallery = [];
  state.gallery = [];
  state.scanTargetId = null;
  state.scanTargetName = '';
  state.savedScan = loadScanCache();
  if (state.savedScan?.gallery?.length) state.localGallery = state.savedScan.gallery;
  save('name', state.name);

  if (!state.name || !state.room) return;
  state.startingLobby = true;
  setTitleBusy(true);
  setJoinStatus('Starting camera and loading the detector...');
  // Dialled before the wait, not after it. Joining a room is network I/O that shares nothing with
  // the models, and the roster it answers with is the only thing the lobby list is made of - so
  // opening it first is what makes the lobby arrive populated instead of empty. net.js reads
  // name/room/resumePlayerId/localGallery out of `state` when the connection opens, and all four
  // are set above, so there is nothing left for it to wait for.
  connect();

  let failure = null;
  try {
    await prepareCameraAndDetector();
  } catch (err) {
    console.error(err);
    failure = err;
  }
  // The room may have turned us away while we were waiting (showJoinRejected has already put the
  // title screen back and closed the connection); that attempt is over, whatever the camera did.
  if (!state.startingLobby) return;
  state.startingLobby = false;

  if (failure) {
    abandonJoin(startupErrorMessage(failure));
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
  markLobbyVisible();
  renderLobby();
  // The connection has been open through the whole wait, so it may already have failed and
  // retried. showConnectionProblem only writes to the screen that is showing, and the title screen
  // was showing at the time, so re-apply whatever it last said now that the lobby can show it.
  showConnectionProblem(state.bannerOverride);
  if (!state.loopStarted) {
    state.loopStarted = true;
    requestAnimationFrame(loop);
  }
  // A round already in countdown or playing - a resume landing mid-match - could arrive while the
  // title screen was still up, and net.js's onState only enters the game from the lobby, so it was
  // recorded and nothing more. Apply it now that there is a lobby to leave.
  if (state.game?.status === 'countdown' || state.game?.status === 'playing') enterGame();
}

// A join that got as far as dialling the room but cannot finish. The server already has us in the
// room, so leave it again rather than parking a player in everyone else's roster who can never be
// scanned or shot - and leaveRoom, not conn.close(), because the connection may already have
// dropped and have a reconnect pending that would rejoin from the title screen.
function abandonJoin(message) {
  state.startingLobby = false;
  leaveRoom({ notify: true });
  state.myId = null;
  state.game = null;
  state.roster = [];
  setJoinStatus(message);
  setTitleBusy(false);
}

export function setJoinStatus(text) {
  $('join-status').textContent = text;
}

export function showJoinRejected(message) {
  // Clearing this is what stops a join whose models are still loading from unhiding the lobby
  // over the top of this screen when they finally arrive (see startLobby).
  state.startingLobby = false;
  // leaveRoom rather than conn.close(): the room may have turned us away because of a reconnect
  // that is itself still pending behind a drop, and that retry would rejoin the room we were just
  // rejected from - the rejection path exists precisely to not leave a phantom behind.
  leaveRoom();
  state.events?.close();
  state.events = null;
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
