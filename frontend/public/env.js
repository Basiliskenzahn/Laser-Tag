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
// Motion tracking is opt-in. ?motion=on enables phone-motion identity fusion, and
// ?motion=strict makes a shot count only when motion confirms the target.
export const MOTION_ENABLED = motionMode === 'on' || motionMode === 'strict';
export const REQUIRE_MOTION = motionMode === 'strict';
export const MOTION_OFF = !MOTION_ENABLED;
// ?motion=on&record additionally records everything the motion matcher consumed, for later
// replay through tools/motion-replay.js. Only meaningful with motion on, and the recorder module
// is imported lazily so a normal game never loads it (see motion/capture.js).
export const MOTION_RECORD = MOTION_ENABLED && params.has('record');

export const video = $('video');
export const canvas = $('overlay');
export const ctx = canvas.getContext('2d');
