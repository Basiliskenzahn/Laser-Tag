// Camera sensor zoom (frontend/public/camera-zoom.js, wired up in camera.js).
//
// Two properties here matter more than the feature, and most of this file is about them rather
// than about zooming:
//
//   1. An unsupported device must behave exactly as it does today. A camera that fails to start is
//      far worse than a camera that cannot zoom, so "nothing throws" and "the track is not touched
//      at all when zoom is off" are both asserted directly - the latter with a track that throws on
//      any property access whatsoever, which is the only way to prove a no-op rather than assume it.
//   2. Enrolment stays at 1x. The scan builds the gallery every phone matches against for the whole
//      round; a gallery captured at one zoom and matched at another is a domain mismatch that would
//      quietly cost accuracy. zoomForMode is where that rule lives, so it is pinned per screen.
//
// The last group is source-level rather than behavioural, and that is a real limitation worth
// stating plainly: `frontend/public/camera.js` cannot be imported under Node, because it reaches
// detector.js, which imports '/vendor/tasks-vision/vision_bundle.mjs' - an absolute URL Node will
// not resolve (the same wall test/scan-run-token.test.js documents). Everything that makes a
// decision was therefore put in camera-zoom.js, which has no imports and is driven for real below;
// what is left in camera.js is wiring, and the last group pins the four properties of that wiring
// which would silently undo the two guarantees above if edited away.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  ZOOM_PARAM_MAX,
  ZOOM_WHEN_ON,
  applyTrackZoom,
  clampZoom,
  createZoomController,
  parseZoomParam,
  zoomForMode,
  zoomStatusLabel,
} from '../frontend/public/camera-zoom.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

// A MediaStreamTrack as much of one as this module touches. Every fake way a phone can refuse to
// zoom is a flag here, because those are the paths that must not break the camera.
function fakeTrack({
  caps = { zoom: { min: 1, max: 4 } },
  // 'echo' = report back whatever was applied; a number = report that instead; null = a device that
  // accepts the constraint but has no `zoom` in its settings at all.
  settingsZoom = 'echo',
  reject = null,
  noGetCapabilities = false,
  capabilitiesThrows = false,
  noGetSettings = false,
  settingsThrows = false,
  readyState = 'live',
} = {}) {
  const calls = [];
  let lastApplied = 1;
  const track = {
    readyState,
    calls,
    applyConstraints: async (constraints) => {
      calls.push({ applyConstraints: constraints });
      if (reject) throw reject;
      lastApplied = constraints?.advanced?.[0]?.zoom ?? constraints?.zoom;
    },
  };
  if (!noGetCapabilities) {
    track.getCapabilities = () => {
      calls.push({ getCapabilities: true });
      if (capabilitiesThrows) throw new Error('not implemented in this WebView');
      return caps;
    };
  }
  if (!noGetSettings) {
    track.getSettings = () => {
      calls.push({ getSettings: true });
      if (settingsThrows) throw new Error('nope');
      if (settingsZoom === 'echo') return { zoom: lastApplied };
      return settingsZoom == null ? {} : { zoom: settingsZoom };
    };
  }
  return track;
}

// Anything at all done to this fails the test. The only way to assert a true no-op.
const untouchableTrack = () =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`the camera track must not be touched when zoom is off (read "${String(prop)}")`);
      },
    },
  );

const applyCalls = (track) => track.calls.filter((call) => 'applyConstraints' in call);
const zoomsAsked = (track) => applyCalls(track).map((call) => call.applyConstraints.advanced[0].zoom);

// ---- ?zoom= parsing ----

test('?zoom= reads a magnification, a switch, or nothing at all', () => {
  assert.equal(parseZoomParam('2'), 2);
  assert.equal(parseZoomParam('2.5'), 2.5);
  assert.equal(parseZoomParam('3'), 3);
  // Literals, not ZOOM_WHEN_ON: asserting `=== ZOOM_WHEN_ON` here would be x === x and would
  // survive any retune of the constant. The constant is pinned separately below as a tripwire.
  assert.equal(parseZoomParam('on'), 2);
  assert.equal(parseZoomParam(' ON '), 2, 'typed by hand on a phone keyboard, so be forgiving');
  assert.equal(parseZoomParam('yes'), 2);
});

test('the default stays conservative', () => {
  // Deliberately a separate test from the parsing above. Zoom narrows the field of view, which
  // makes a target harder to find and aiming twitchier, so if someone raises `?zoom=on`'s level
  // that should be a visible decision rather than a silent side effect of the parser's tests.
  assert.equal(ZOOM_WHEN_ON, 2);
  assert.equal(ZOOM_PARAM_MAX, 10);
  assert.equal(parseZoomParam(null), null, 'absent means off: no zoom unless it was asked for');
});

test('every value that cannot be read is off, so a typo cannot stop the camera', () => {
  for (const raw of [
    null,
    undefined,
    '',
    '   ',
    'off',
    'no',
    'false',
    '0',
    '1', // off by another name
    '0.5', // would zoom out and shrink the people this exists for
    '-2',
    'abc',
    '2x',
    'two',
    'NaN',
    'Infinity',
    '1e9', // beyond ZOOM_PARAM_MAX
    '11',
    '{}',
  ]) {
    assert.equal(parseZoomParam(raw), null, `?zoom=${String(raw)} should be off, not a thrown error`);
  }
});

// ---- Clamping to the device's reported range ----

test('a request beyond the device range clamps instead of being sent and rejected', () => {
  // Literal expectations throughout: the range is the fake device's, not a constant of ours.
  assert.equal(clampZoom(8, { min: 1, max: 4 }), 4, 'above max clamps to max');
  assert.equal(clampZoom(1.2, { min: 2, max: 6 }), 2, 'below min clamps to min');
  assert.equal(clampZoom(3, { min: 1, max: 4 }), 3, 'inside the range is left alone');
  assert.equal(clampZoom(100, { min: 1, max: 1 }), 1, 'a device that reports no headroom gets 1x');
});

test('a device that reports a step gets a value on one', () => {
  assert.equal(clampZoom(2.3, { min: 1, max: 5, step: 0.5 }), 2.5);
  assert.equal(clampZoom(2.1, { min: 1, max: 5, step: 1 }), 2);
  assert.equal(clampZoom(4.9, { min: 1, max: 5, step: 2 }), 5, 'snapping must not walk past max');
  assert.equal(clampZoom(1.1, { min: 1, max: 5, step: 2 }), 1, 'nor below min');
  assert.equal(clampZoom(2.3, { min: 1, max: 5 }), 2.3, 'no step reported, nothing to snap to');
  // Drivers report steps like 0.1 that are not binary fractions; without rounding this is
  // 2.0000000000000004 and the debug line reads like a bug.
  assert.equal(clampZoom(2, { min: 1, max: 5, step: 0.1 }), 2);
});

// ---- Applying it to a track that may not cooperate ----

test('a camera with no zoom in its capabilities is never asked to zoom', async () => {
  const track = fakeTrack({ caps: { width: { max: 1920 } } });
  const status = await applyTrackZoom(track, 2);

  assert.equal(status.state, 'unsupported');
  assert.equal(status.zoom, null);
  assert.deepEqual(applyCalls(track), [], 'applyConstraints must not be called at all');
});

test('a camera with no getCapabilities at all degrades silently', async () => {
  const track = fakeTrack({ noGetCapabilities: true });
  const status = await applyTrackZoom(track, 2);

  assert.equal(status.state, 'unsupported');
  assert.deepEqual(applyCalls(track), []);
});

test('a getCapabilities that throws is still just "no zoom here"', async () => {
  const track = fakeTrack({ capabilitiesThrows: true });
  const status = await applyTrackZoom(track, 2);

  assert.equal(status.state, 'unsupported');
  assert.deepEqual(applyCalls(track), []);
});

test('an applyConstraints that rejects leaves a working camera behind', async () => {
  const track = fakeTrack({ reject: new DOMException('OverconstrainedError') });
  // Not throwing is the assertion; reaching the next line at all is the point of the test.
  const status = await applyTrackZoom(track, 2);

  assert.equal(status.state, 'failed');
  assert.equal(status.zoom, null);
  assert.match(status.reason, /applyConstraints rejected/);
});

test('a track that has already ended is not an error either', async () => {
  const status = await applyTrackZoom(fakeTrack({ readyState: 'ended' }), 2);
  assert.equal(status.state, 'unsupported');
  assert.equal(await applyTrackZoom(null, 2).then((s) => s.state), 'unsupported', 'nor is no track at all');
});

test('the request is clamped to the device range before it is sent', async () => {
  const track = fakeTrack({ caps: { zoom: { min: 1, max: 4 } } });
  const status = await applyTrackZoom(track, 8);

  assert.deepEqual(zoomsAsked(track), [4], 'the device was asked for 4x, not the impossible 8x');
  assert.equal(status.state, 'applied');
  assert.equal(status.zoom, 4);
  assert.equal(status.requested, 8, 'what was asked for is still reported, for the debug line');
});

test('zoom is asked for as an advanced constraint, so a half-supporting device still gives a stream', async () => {
  // A plain `{ zoom: n }` is a *required* constraint: a device that cannot meet it fails the whole
  // call. Inside `advanced` it is best-effort. This is the difference between "cannot zoom" and
  // "cannot use the camera", which is the whole risk of the feature.
  const track = fakeTrack();
  await applyTrackZoom(track, 2);

  const constraints = applyCalls(track)[0].applyConstraints;
  assert.deepEqual(constraints, { advanced: [{ zoom: 2 }] });
  assert.equal(constraints.zoom, undefined, 'never a required top-level constraint');
});

test('the reported zoom is what the sensor says, not what was asked for', async () => {
  // The device accepts 4x and quietly lands on 2.4x. Reporting 4 here would make the debug line a
  // transcript of our own request, which is exactly what it must not be.
  const track = fakeTrack({ caps: { zoom: { min: 1, max: 4 } }, settingsZoom: 2.4 });
  const status = await applyTrackZoom(track, 4);

  assert.equal(status.zoom, 2.4);
  assert.equal(status.target, 4, 'and what we aimed for is kept separately');
  assert.equal(zoomStatusLabel(status), ' zoom 2.4x');
});

test('a device that will not say what it did is reported as unconfirmed, not as success', async () => {
  for (const track of [fakeTrack({ noGetSettings: true }), fakeTrack({ settingsThrows: true }), fakeTrack({ settingsZoom: null })]) {
    const status = await applyTrackZoom(track, 2);
    assert.equal(status.state, 'unapplied');
    assert.equal(status.zoom, null, 'with no read-back there is no number we are entitled to claim');
    assert.equal(zoomStatusLabel(status), ' zoom 2x?');
  }
});

test('with zoom off the track is not touched in any way', async () => {
  // The proxy throws on every property read, so this passes only if the function returns before
  // looking at the track at all - not merely before calling applyConstraints.
  const status = await applyTrackZoom(untouchableTrack(), null);
  assert.equal(status.state, 'off');
  assert.equal(status.zoom, null);
  assert.equal(zoomStatusLabel(status), '', 'and it adds nothing to the debug line');
});

// ---- Enrolment stays at 1x ----

test('only the gameplay screen zooms; enrolment and everything else stay at 1x', () => {
  assert.equal(zoomForMode('game', 2), 2);
  // The accuracy decision. The scan's gallery is matched by every phone in the room for the whole
  // round, and each phone has its own zoom capability and its own URL, so the scanning phone's
  // zoom is not the matching phone's. 1x is the only level they all agree on.
  assert.equal(zoomForMode('scan', 2), 1, 'a zoomed gallery would be a domain mismatch for everyone');
  assert.equal(zoomForMode('lobby', 2), 1);
  assert.equal(zoomForMode('join', 2), 1);
});

test('with zoom off no screen zooms, including gameplay', () => {
  for (const mode of ['join', 'lobby', 'scan', 'game']) {
    assert.equal(zoomForMode(mode, null), null, `${mode} must stay off`);
  }
});

// ---- The debug line ----

test('the debug line distinguishes zooming from failing to zoom', () => {
  assert.equal(zoomStatusLabel({ state: 'applied', zoom: 2 }), ' zoom 2x');
  assert.equal(zoomStatusLabel({ state: 'applied', zoom: 2.5 }), ' zoom 2.5x');
  assert.equal(zoomStatusLabel({ state: 'applied', zoom: 1 }), ' zoom 1x', 'the deliberate state during enrolment');
  assert.equal(zoomStatusLabel({ state: 'unsupported', requested: 2 }), ' zoom n/a');
  assert.equal(zoomStatusLabel({ state: 'failed', requested: 2 }), ' zoom failed');
  assert.equal(zoomStatusLabel({ state: 'off' }), '');
  assert.equal(zoomStatusLabel(undefined), '', 'before anything has happened');
});

// ---- The controller that keeps the track in step with the screen ----

function controller({ mode = 'lobby', requested = 2, track = fakeTrack() } = {}) {
  const statuses = [];
  const state = { mode, track };
  const zoom = createZoomController({
    getTrack: () => state.track,
    getMode: () => state.mode,
    requested,
    onStatus: (status) => statuses.push(status),
  });
  return { zoom, state, statuses, track };
}

test('with zoom off the controller is inert and never looks at the track', async () => {
  const { zoom } = controller({ requested: null, track: untouchableTrack() });
  assert.equal(zoom.enabled, false, 'camera.js checks this before it even starts a watcher');
  await zoom.sync();
  assert.equal(zoom.label(), '');
  assert.equal(zoom.status().state, 'off');
});

test('nothing is sent to the camera while the lobby or the scan is on screen', async () => {
  const { zoom, state, track } = controller({ mode: 'lobby' });
  await zoom.sync();
  state.mode = 'scan';
  await zoom.sync();

  // Not even getCapabilities: a fresh stream is already at 1x, which is what these screens want,
  // so there is nothing to ask for. This is also what keeps zoom away from the model warm-up.
  assert.deepEqual(track.calls, [], 'the camera must be left entirely alone outside gameplay');
  assert.equal(zoom.label(), '');
});

test('the game zooms, and leaving the game puts the sensor back to 1x', async () => {
  const { zoom, state, track } = controller({ mode: 'lobby' });
  await zoom.sync();

  state.mode = 'game';
  await zoom.sync();
  assert.deepEqual(zoomsAsked(track), [2]);
  assert.equal(zoom.label(), ' zoom 2x');

  state.mode = 'scan';
  await zoom.sync();
  assert.deepEqual(zoomsAsked(track), [2, 1], 'enrolment after a round must not inherit the zoom');
  assert.equal(zoom.label(), ' zoom 1x');
});

test('staying on one screen does not re-ask the camera every poll', async () => {
  const { zoom, state, track } = controller({ mode: 'game' });
  await zoom.sync();
  await zoom.sync();
  await zoom.sync();

  assert.deepEqual(zoomsAsked(track), [2], 'applyConstraints renegotiates with the camera; once is enough');
});

test('a camera that cannot zoom is asked exactly once, however long the round lasts', async () => {
  const { zoom, state, track } = controller({ mode: 'game', track: fakeTrack({ caps: {} }) });
  for (let i = 0; i < 20; i += 1) await zoom.sync();

  assert.equal(track.calls.length, 1, 'one getCapabilities for the whole session, and no spam');
  assert.equal(zoom.label(), ' zoom n/a');
});

test('two syncs cannot overlap, so the camera is never renegotiated out of order', async () => {
  // applyConstraints renegotiates with the camera and takes real time, so the watcher's next poll
  // can easily arrive while one is still in flight. Two concurrent calls can land out of order and
  // leave the sensor at the level of whichever finished last rather than whichever was asked last.
  //
  // The overlap is *recorded* rather than asserted inside the fake, which matters: a throw in here
  // is swallowed by applyTrackZoom's own catch and reported as a mere 'failed' status, so an
  // assertion placed here would never reach the test runner. Found by mutation-testing this file -
  // removing the serialisation left the first version of this test green.
  let inFlight = 0;
  let maxInFlight = 0;
  const track = fakeTrack();
  const inner = track.applyConstraints;
  track.applyConstraints = async (constraints) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await settle();
    await inner(constraints);
    inFlight -= 1;
  };

  const { zoom, state } = controller({ mode: 'game', track });
  // Both syncs want 2x and neither has been recorded as applied yet, so an unserialised controller
  // issues two overlapping applyConstraints here.
  const first = zoom.sync();
  const second = zoom.sync();
  await first;
  await second;
  await settle();

  assert.equal(maxInFlight, 1, 'a second applyConstraints started while the first was still running');
  assert.deepEqual(zoomsAsked(track), [2], 'and the queued sync found nothing left to do');
});

test('a screen change during an applyConstraints still ends at the right level', async () => {
  const track = fakeTrack();
  const inner = track.applyConstraints;
  track.applyConstraints = async (constraints) => {
    await settle();
    await inner(constraints);
  };

  const { zoom, state } = controller({ mode: 'game', track });
  const first = zoom.sync();
  state.mode = 'scan'; // the player left the game while the camera was still being zoomed
  // This sync arrives while the first is in flight, so it cannot run now. Dropping it would leave
  // the sensor zoomed through the whole of the next enrolment, and no further call is made here on
  // purpose: the re-queue inside the controller is the thing under test, not the next poll.
  zoom.sync();
  await first;

  assert.deepEqual(zoomsAsked(track), [2, 1], 'the level the player ended on is the one that sticks');
  assert.equal(zoom.label(), ' zoom 1x', 'and enrolment is back at 1x, not left on the round’s zoom');
});

test('a camera that keeps rejecting the zoom reports it once, not once per poll', async () => {
  // Unlike 'unsupported', a rejection can be transient (the camera busy mid-renegotiation), so it
  // is retried rather than latched. That makes this the one path that can run four times a second
  // for a whole round - and "no console spam beyond one debug line" is a hard requirement, so the
  // status callback behind that line must fire on a *change* of state, not on every attempt.
  const track = fakeTrack({ reject: new DOMException('TypeError') });
  const { zoom, statuses } = controller({ mode: 'game', track });
  for (let i = 0; i < 20; i += 1) await zoom.sync();

  assert.equal(statuses.length, 1, 'one debug line for the round, however many attempts were made');
  assert.equal(zoom.label(), ' zoom failed');
  assert.ok(applyCalls(track).length > 1, 'and the attempt itself is still retried, in case it clears');
});

test('the debug line is only rewritten when something actually changed', async () => {
  const { zoom, state, statuses } = controller({ mode: 'game' });
  await zoom.sync();
  await zoom.sync();
  await zoom.sync();
  assert.equal(statuses.length, 1);

  state.mode = 'lobby';
  await zoom.sync();
  assert.equal(statuses.length, 2);
  assert.deepEqual(
    statuses.map((s) => s.zoom),
    [2, 1],
  );
});

test('a new stream is zoomed again rather than assumed to be where the old one was', async () => {
  const { zoom, state } = controller({ mode: 'game' });
  await zoom.sync();

  zoom.reset(); // what stopCamera does
  assert.equal(zoom.label(), '');
  state.track = fakeTrack();
  await zoom.sync();
  assert.deepEqual(zoomsAsked(state.track), [2], 'the replacement stream gets its own applyConstraints');
});

// ---- The wiring left in camera.js, which Node cannot import (see the header) ----

const CAMERA_SRC = readFileSync(fileURLToPath(new URL('../frontend/public/camera.js', import.meta.url)), 'utf8');

/** Strip comments, so prose describing a rule cannot satisfy an assertion about the code. */
const code = (text) => text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of a top-level `function name(...) { ... }`, by brace counting. */
function functionBody(src, name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(start, -1, `no function ${name} in camera.js`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return code(src.slice(open + 1, i));
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test('zoom is never part of the getUserMedia constraints', () => {
  // A `zoom` entry in the initial constraints is a *required* constraint on a property most phones
  // do not have: an OverconstrainedError, and a camera that never starts. That failure is far worse
  // than having no zoom, which is the reason the whole feature is a follow-up applyConstraints.
  const body = functionBody(CAMERA_SRC, 'startCamera');
  const getUserMedia = body.slice(body.indexOf('getUserMedia'), body.indexOf('video.play'));
  assert.doesNotMatch(getUserMedia, /zoom/, 'zoom must not appear in the getUserMedia constraints');
});

test('startCamera does not await the zoom, so it cannot delay the lobby gate', () => {
  // startup.js gates the lobby on `Promise.all([camera, object])`, and `camera` is this function.
  // Awaiting applyConstraints here would put a camera renegotiation on the player's way into the
  // room - and on a device that hangs on being asked, nothing would ever open the lobby.
  const body = functionBody(CAMERA_SRC, 'startCamera');
  assert.match(body, /startZoomWatcher\(\)/, 'startCamera no longer starts the zoom watcher at all');
  assert.doesNotMatch(body, /await\s+startZoomWatcher/, 'the zoom must not be on the lobby gate path');
  assert.match(body, /video\.play\(\)[\s\S]*startZoomWatcher/, 'and it needs a live stream, so it comes after play()');
});

test('the zoom watcher follows the screen the player is on and the ?zoom= parameter', () => {
  const body = functionBody(CAMERA_SRC, 'startZoomWatcher');
  assert.match(body, /getMode:\s*\(\)\s*=>\s*state\.mode/, 'without this enrolment would zoom too');
  assert.match(body, /requested:\s*CAMERA_ZOOM/, 'the level must come from ?zoom=, not a hardcoded one');
  assert.match(body, /getVideoTracks/, 'the zoom is a property of the video track');
  assert.match(body, /if\s*\(!zoom\.enabled\)/, 'no watcher at all when ?zoom= was not given');
});

test('stopping the camera stops the zoom watcher with it', () => {
  // A surviving interval would poll a dead track for the rest of the page's life, and a surviving
  // controller would believe the next stream is already zoomed.
  assert.match(functionBody(CAMERA_SRC, 'stopCamera'), /stopZoomWatcher\(\)/);
  assert.match(functionBody(CAMERA_SRC, 'stopZoomWatcher'), /clearInterval/);
});

test('?zoom= is read once at startup, through the same parser tested above', () => {
  // env.js cannot be imported here either (it needs `location` and `document`), so this pins the
  // one line that connects the address bar to the parser. Reading it anywhere other than env.js, or
  // reading it per frame, would both break the convention the other switches follow.
  const envSrc = code(readFileSync(fileURLToPath(new URL('../frontend/public/env.js', import.meta.url)), 'utf8'));
  assert.match(envSrc, /export const CAMERA_ZOOM = parseZoomParam\(params\.get\('zoom'\)\)/);
  assert.match(envSrc, /import \{ parseZoomParam \} from '\.\/camera-zoom\.js'/);
});

test('the zoom is reported on the delegate line the overlay already shows', () => {
  // Requirement: no parallel debug mechanism, and nothing added to screens/game.js, which reads
  // `state.delegate` and nothing else.
  const body = functionBody(CAMERA_SRC, 'refreshDelegateLabel');
  assert.match(body, /state\.delegate\s*=/);
  assert.match(body, /zoom\?\.label\(\)/, 'the delegate line no longer carries the zoom');
});
