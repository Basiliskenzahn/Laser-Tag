// Where this phone currently is: who we are, what the server last told us, which models are
// loaded and what the camera sees right now. Every other module imports this one `state` object
// and reads or mutates fields on it, rather than threading it through every call.
//
// The localStorage helpers live here too.

import { Tracker } from './identify.js';

export const state = {
  name: '',
  room: '',
  conn: null, // connection to the game server (transport.js)
  myId: null,
  game: null, // latest state snapshot from the server (hp, status, ...)
  roster: [], // latest roster from the server (id, name, gallery)
  detector: null,
  poseDetector: null,
  embedder: null,
  reid: null, // person re-identification (reid.js); null if it couldn't load
  delegate: '',
  mode: 'join', // 'join' | 'lobby' | 'scan' | 'game' | 'results' (round over for us, camera still up)
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
  postProcessingScan: false,
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
