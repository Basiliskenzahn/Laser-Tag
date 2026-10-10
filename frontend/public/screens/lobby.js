// The waiting room: who is in the room, whose scan is still missing, and the launch button.
//
// Nobody can be shot before they have been scanned, so the list exists mainly to show which
// players still need it and to start a scan for any of them from this one phone. It is also the
// screen everything else comes back to - showLobby() is the single "we're done, here is what
// happened" exit used by the scan flow and by the end of a round - so it owns hiding the other
// screens and clearing their countdowns.

import { canvas, video, $ } from '../env.js';
import { stopCamera } from '../camera.js';
import { clearActiveLobby, state } from '../state.js';
import { cloneOwnerId, missingScanPlayers, playerName, scannedGallery } from '../roster.js';
import { send, showConnectionProblem } from '../net.js';
import { clearGameCountdown, enterGame, updateCountdown } from './game.js';
import { setJoinStatus } from './join.js';
import { beginPlayerScan, hideScanCountdown } from './scan.js';

const GAME_LAUNCH_COUNTDOWN_MS = 3_000; // mirrors server/game.js's COUNTDOWN_MS

export function renderLobby() {
  $('lobby-room').textContent = `Room ${state.game?.code ?? state.room}`;
  const list = $('lobby-list');
  list.innerHTML = '';
  const players = state.game?.players ?? state.roster;
  for (const player of players) {
    const rosterPlayer = state.roster.find((candidate) => candidate.id === player.id) ?? player;
    const ownerId = cloneOwnerId(player.id);
    const ownerName = ownerId ? playerName(ownerId) : '';
    const gallery = ownerId ? scannedGallery(ownerId) : rosterPlayer.gallery;
    const scanned = Boolean(gallery?.length);
    const row = document.createElement('div');
    row.className = `lobby-player${scanned ? ' scanned' : ''}${ownerId ? ' mirrored' : ''}`;

    const details = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'lobby-name';
    name.textContent = `${player.name}${player.id === state.myId ? ' (you)' : ''}`;
    const status = document.createElement('div');
    status.className = 'lobby-state';
    status.textContent = ownerId
      ? scanned
        ? `Mirrors ${ownerName}'s scan`
        : `Waiting for ${ownerName}'s scan`
      : scanned
        ? `${gallery.length} scan samples ready`
        : 'Not scanned';
    details.append(name, status);

    row.append(details);
    if (!ownerId) {
      const scanBtn = document.createElement('button');
      scanBtn.type = 'button';
      scanBtn.textContent = scanned ? 'Rescan' : 'Scan';
      scanBtn.disabled = state.game?.status === 'countdown' || state.game?.status === 'playing';
      scanBtn.addEventListener('click', () => beginPlayerScan(rosterPlayer));
      row.append(scanBtn);
    }
    list.append(row);
  }
  $('launch-btn').disabled = !state.game || state.game.status === 'countdown' || state.game.status === 'playing';
}

export function showLobby(message = '') {
  state.mode = 'lobby';
  state.launchingFromLobby = false;
  state.events?.close();
  state.events = null;
  $('join-screen').hidden = true;
  $('scan-screen').hidden = true;
  hideScanCountdown();
  clearGameCountdown();
  $('game-screen').hidden = true;
  $('lobby-screen').hidden = false;
  video.hidden = true;
  canvas.hidden = true;
  $('lobby-status').textContent = message;
  renderLobby();
}

export function leaveLobby() {
  state.autoScanning = false;
  state.postProcessingScan = false;
  state.conn?.close({ notify: true });
  state.conn = null;
  state.events?.close();
  state.events = null;
  clearActiveLobby();
  hideScanCountdown();
  clearGameCountdown();
  state.launchingFromLobby = false;
  stopCamera();
  state.mode = 'join';
  state.myId = null;
  state.game = null;
  state.roster = [];
  state.gallery = [];
  state.localGallery = [];
  state.scanThumbs = [];
  state.scanTargetId = null;
  state.scanTargetName = '';
  $('scan-thumbs').innerHTML = '';
  $('join-screen').hidden = false;
  $('lobby-screen').hidden = true;
  $('scan-screen').hidden = true;
  $('game-screen').hidden = true;
  video.hidden = true;
  canvas.hidden = true;
  $('join-btn').hidden = false;
  $('join-btn').disabled = false;
  setJoinStatus('');
  showConnectionProblem(null);
}

export function launchGame() {
  const missing = missingScanPlayers();
  if (missing.length) {
    $('lobby-status').textContent = `Scan everyone before launch: ${missing.map((p) => p.name).join(', ')}`;
    return;
  }
  $('lobby-status').textContent = 'Launching...';
  state.countdownEndsAt = performance.now() + GAME_LAUNCH_COUNTDOWN_MS;
  state.lastCountdownBeep = null;
  state.launchingFromLobby = true;
  enterGame();
  updateCountdown();
  send({ type: 'start' });
}
