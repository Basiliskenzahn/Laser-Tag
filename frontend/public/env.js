// The handful of things the whole front end shares: the debug switches read off the query
// string, a one-line element lookup, and the single camera <video> with the <canvas> drawn over
// it.
//
// The camera stream is requested once and reused by the scan screen and the game screen, so
// every module has to be looking at the same two elements; importing them from here is what
// guarantees that.

export const $ = (id) => document.getElementById(id);
export const params = new URLSearchParams(location.search);
export const DEBUG = params.has('debug');
const motionMode = params.get('motion');

// ---- This branch: motion-only tracking ----
//
// An experiment to measure the phone-motion signal on its own, because nothing has ever
// measured it against real hardware - its published accuracy comes from a random-walk
// simulation (see motion/matching.js and docs/streamlining.md).
//
// So on this branch the appearance pipeline is OFF by default: no colour signature, no
// MobileNet embedding, no OSNet re-identification. People are still *tracked* frame to frame,
// but who they are comes purely from correlating each tracked person's movement on screen
// against each phone's accelerometer, and every person on screen is labelled with how well
// each player matches them.
//
// ?appearance=on puts the normal pipeline back, so the two can be compared on one build.
export const APPEARANCE_OFF = params.get('appearance') !== 'on';

// Motion is normally opt-in (?motion=on, or ?motion=strict to require it for a shot), but with
// appearance off it is the only signal left, so it has to be on or nothing identifies anybody.
export const MOTION_ENABLED = APPEARANCE_OFF || motionMode === 'on' || motionMode === 'strict';
export const REQUIRE_MOTION = motionMode === 'strict';
export const MOTION_OFF = !MOTION_ENABLED;

export const video = $('video');
export const canvas = $('overlay');
export const ctx = canvas.getContext('2d');
