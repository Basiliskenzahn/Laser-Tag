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
// Scan export is opt-in: ?export shows Import on every player in the lobby, and Export and a
// delete (✕) button on each scanned one.
export const SCAN_EXPORT = params.has('export');
const motionMode = params.get('motion');
// Phone-motion confirmation is OFF unless asked for: ?motion=on makes phones share accelerometer
// activity, shows what the correlation makes of each person on screen in the debug overlay, and
// lets a confirmed target be labelled as such. It cannot change who may be shot - see target.js.
//
// There is one mode. `?motion=strict` used to be a second one that *withheld* a target motion had
// not confirmed, and it is now an alias for `on`: motion may contribute to a decision, never
// replace it, and withholding is replacing. It also made the game unplayable - correlation needs
// variance, so two people standing still reads as `unknown` (motion/matching.js calls that by far
// the most common answer) and a stand-off made everybody unshootable. The spelling is still
// accepted rather than rejected so that a typed-out URL degrades to the working mode instead of
// silently turning motion off.
//
// The flags before these claimed in this very comment to be "on by default, ?motion=off disables
// it", while the code beside them required `on` or `strict` exactly as it does here. The code was
// right and every doc that described the default was wrong.
export const MOTION_ENABLED = motionMode === 'on' || motionMode === 'strict';
// ?reid=0.70: the re-identification accept threshold, for tuning in the field (identify.js).
export const REID_THRESHOLD = params.has('reid') ? Number(params.get('reid')) : null;

export const video = $('video');
export const canvas = $('overlay');
export const ctx = canvas.getContext('2d');
