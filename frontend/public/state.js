// Where this phone currently is: who we are, what the server last told us, which models are
// loaded and what the camera sees right now. Every other module imports this one `state` object
// and reads or mutates fields on it, rather than threading it through every call.
//
// The localStorage helpers live here too, including the small "active lobby" record: a refresh
// wipes everything above, and that record is what lets the reloaded page rejoin as the same
// player instead of as a stranger.

import { Tracker } from './identify.js';
import { DEBUG } from './env.js';

export const state = {
  name: '',
  room: '',
  conn: null, // connection to the game server (transport.js)
  connected: false, // is that connection live? false while net.js is between retries
  myId: null,
  // Latest state snapshot from the server (hp, status, ...). Deliberately kept across a
  // connection blip rather than cleared, so the HUD and firing survive one; `connected` above is
  // what says whether it is still live (net.js).
  game: null,
  roster: [], // latest roster from the server (id, name, gallery)
  detector: null,
  poseDetector: null,
  embedder: null,
  reid: null, // person re-identification (reid.js); null if it couldn't load
  objectDelegate: '', // 'GPU' | 'CPU', whichever the object detector managed; the rest follow it
  delegate: '', // objectDelegate plus a suffix per optional model that loaded, for the overlay
  mode: 'join', // 'join' | 'lobby' | 'scan' | 'game'
  startingLobby: false, // a join is in flight: camera/models still loading behind the join screen
  boxes: [], // people in the latest camera frame, in video pixels
  tracker: new Tracker(),
  tracks: [],
  gallery: [], // signatures captured for the player currently being scanned
  localGallery: [], // this phone owner's gallery, used only as a self-match guard
  scanThumbs: [], // data URLs matching gallery samples, used for the reusable debug cache
  savedScan: null,
  scanTargetId: null,
  scanTargetName: '',
  resumePlayerId: null,
  autoScanning: false,
  recordingScan: false, // the 12 s rotation recording specifically; no preview detection runs then
  postProcessingScan: false,
  lastScanPreviewAt: 0,
  loopStarted: false,
  events: null,
  failedConnects: 0, // connection attempts in a row that never opened
  lastShotAt: 0,
  lastGameDetectAt: 0,
  lastGamePoseDetectAt: 0,
  countdownEndsAt: null,
  lastCountdownBeep: null,
  launchingFromLobby: false,
  bannerOverride: null,
};

export function load(key) {
  try {
    return localStorage.getItem(`laser-tag:${key}`);
  } catch {
    return null;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(`laser-tag:${key}`, value);
  } catch {
    // Private mode etc.; remembering the name is only a convenience.
  }
}

export function removeSaved(key) {
  try {
    localStorage.removeItem(`laser-tag:${key}`);
  } catch {
    // Private mode etc.; this is only a convenience.
  }
}

export function loadActiveLobby() {
  try {
    const lobby = JSON.parse(load('activeLobby'));
    if (
      lobby?.version === 1 &&
      lobby.debug === DEBUG &&
      typeof lobby.name === 'string' &&
      typeof lobby.room === 'string' &&
      typeof lobby.playerId === 'string'
    ) {
      return lobby;
    }
  } catch {
    // Ignore corrupt resume data.
  }
  return null;
}

export function saveActiveLobby() {
  if (!state.myId || !state.name || !state.room) return;
  save(
    'activeLobby',
    JSON.stringify({
      version: 1,
      name: state.name,
      room: state.room,
      playerId: state.myId,
      debug: DEBUG,
    }),
  );
}

export function clearActiveLobby() {
  removeSaved('activeLobby');
}
