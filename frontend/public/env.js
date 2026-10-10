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
// ?reid=0.70: the re-identification accept threshold, for tuning in the field (identify.js).
export const REID_THRESHOLD = params.has('reid') ? Number(params.get('reid')) : null;

export const video = $('video');
export const canvas = $('overlay');
export const ctx = canvas.getContext('2d');
