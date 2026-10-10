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
// Phone-motion identity fusion is on by default; ?motion=off disables it (no sensor prompt, no
// shared samples, appearance alone decides), and ?motion=strict makes a shot count only when
// motion confirms the target.
export const MOTION_ENABLED = motionMode === 'on' || motionMode === 'strict';
export const REQUIRE_MOTION = motionMode === 'strict';
export const MOTION_OFF = !MOTION_ENABLED;
// ?reid=0.70: the re-identification accept threshold, for tuning in the field (identify.js).
export const REID_THRESHOLD = params.has('reid') ? Number(params.get('reid')) : null;

export const video = $('video');
export const canvas = $('overlay');
export const ctx = canvas.getContext('2d');
