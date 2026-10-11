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
// Phone-motion confirmation is OFF unless asked for, and the two modes differ in what motion is
// allowed to do:
//
//   ?motion=on      phones share accelerometer activity and the debug overlay shows what the
//                   correlation makes of each person on screen. It cannot change who may be
//                   shot - see target.js. This is the mode to gather field data in.
//   ?motion=strict  additionally requires motion to confirm the target before a shot counts.
//                   This one CAN withhold a shot, which is the whole reason it exists; it is an
//                   experiment, not a way to play.
//
// The old flags claimed in this very comment to be "on by default, ?motion=off disables it",
// while the code beside them required `on` or `strict` exactly as it does here. The code was
// right and every doc that described the default was wrong.
export const MOTION_ENABLED = motionMode === 'on' || motionMode === 'strict';
export const REQUIRE_MOTION = motionMode === 'strict';
// ?reid=0.70: the re-identification accept threshold, for tuning in the field (identify.js).
export const REID_THRESHOLD = params.has('reid') ? Number(params.get('reid')) : null;

export const video = $('video');
export const canvas = $('overlay');
export const ctx = canvas.getContext('2d');
