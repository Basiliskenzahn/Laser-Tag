// The first screen: a name, a room code, and everything that has to succeed before the lobby.
//
// Submitting it starts the camera and loads the models (camera.js), which is slow and can fail
// for reasons the player can fix, so this screen doubles as the status line for those errors. It
// also restores the lobby an accidental reload interrupted, deliberately through the same path as
// a manual join so there is only one way into the lobby. showJoinRejected() is the way back here
// when the server turns the player away.
//
// What this screen waits for is the whole reason it is not slow any more. It used to await every
// model and only then dial the room, so the player sat on the join screen for 17.1 MB of models -
// two thirds of which detector.js has always described as optional - and then waited again for
// the roster to arrive before the lobby had anything in it. Both of those are now overlapped with
// the wait instead of queued behind it: the room is dialled first, because it is network I/O with
// nothing to do with the models, and the lobby opens on camera + object detector alone (startup.js
// explains the split). The roster is normally already in `state` by the time the lobby appears.

import { DEBUG, canvas, params, video, $ } from '../env.js';
import { keepScreenOn, prepareCameraAndDetector, startupErrorMessage, stopCamera } from '../camera.js';
import { markLobbyVisible } from '../startup.js';
import { clearActiveLobby, load, loadActiveLobby, save, state } from '../state.js';
import { connect, showConnectionProblem } from '../net.js';
import { clearGameCountdown, enterGame, loop } from './game.js';
import { renderLobby } from './lobby.js';
import { hideScanCountdown, loadScanCache } from './scan.js';

export function initJoinForm() {
  $('name').value = load('name') ?? '';
  $('room').value = params.get('room') ?? load('room') ?? 'demo';
}

export async function enterLobbyFromForm({ resumePlayerId = null, auto = false } = {}) {
  // Two joins at once would leave an orphaned connection polling the room, which matters now that
  // the connection is opened before the wait rather than after it. `startingLobby` doubles as
  // "this attempt is still the live one": showJoinRejected clears it, so an attempt whose room
  // turned it away below cannot go on to unhide the lobby when its models finally arrive.
  if (state.startingLobby) return;
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
  state.startingLobby = true;
  $('join-btn').hidden = false;
  $('join-btn').disabled = true;
  setJoinStatus(auto ? 'Rejoining lobby...' : 'Starting camera and loading the detector...');
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
  // join screen back and closed the connection); that attempt is over, whatever the camera did.
  if (!state.startingLobby) return;
  state.startingLobby = false;

  if (failure) {
    // The camera is what failed, but the server has us in the room already. Leave it again rather
    // than parking a player in everyone else's roster who can never be scanned or shot.
    state.conn?.close({ notify: true });
    state.conn = null;
    state.myId = null;
    state.game = null;
    state.roster = [];
    setJoinStatus(startupErrorMessage(failure));
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
  markLobbyVisible();
  renderLobby();
  if (!state.loopStarted) {
    state.loopStarted = true;
    requestAnimationFrame(loop);
  }
  // A round already in countdown or playing - a resume landing mid-match - could arrive while the
  // join screen was still up, and net.js's onState only enters the game from the lobby, so it was
  // recorded and nothing more. Apply it now that there is a lobby to leave.
  if (state.game?.status === 'countdown' || state.game?.status === 'playing') enterGame();
}

export function setJoinStatus(text) {
  $('join-status').textContent = text;
}

export function showJoinRejected(message) {
  // Clearing this is what stops a join whose models are still loading from unhiding the lobby
  // over the top of this screen when they finally arrive (see enterLobbyFromForm).
  state.startingLobby = false;
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
