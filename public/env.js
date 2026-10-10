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
// ?motion=strict: a shot only counts when the target's phone motion confirms who it is.
export const REQUIRE_MOTION = params.get('motion') === 'strict';
// ?motion=off: ignore phone motion completely and aim on appearance alone, exactly as the game
// did before motion matching was added. An escape hatch for testing whether motion fusion is
// what is making shots unreliable - see resolveIdentity() in identity.js.
export const MOTION_OFF = params.get('motion') === 'off';

export const video = $('video');
export const canvas = $('overlay');
export const ctx = canvas.getContext('2d');
