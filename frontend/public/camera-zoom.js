// Sensor zoom: making a far-away player big enough to recognise, at no cost per frame.
//
// Players beyond roughly 10-12 m are detected rarely and identified almost never. Two separate
// limits cause it, and zoom is the only lever that moves both at once:
//
//   - The object detector sees every frame at 320x320, so a person 12 m away is a few dozen
//     pixels tall in the tensor and is simply not found.
//   - OSNet's input is 128x256. A distant player's crop is maybe 25x50 real pixels, upscaled ~5x,
//     so the embedding is computed mostly from interpolation.
//
// Asking the *track* to zoom changes what the sensor delivers. The frame arrives already
// magnified, at the same resolution as before, so nothing downstream does any extra work: no
// second inference pass, no extra canvas, no cost to the detection cadence. That is the whole
// reason this approach was chosen over a cropped second detector pass (see the branch report).
//
// This module deliberately has no imports - no DOM, no `state`, no model library - for the same
// reason startup.js has none: camera.js cannot be loaded under Node (it reaches detector.js,
// which imports '/vendor/tasks-vision/vision_bundle.mjs', an absolute URL Node will not resolve),
// so every decision worth testing lives here instead and camera.js keeps only the wiring.
//
// ---- The two properties that matter more than the feature ----
//
// 1. An unsupported device must behave EXACTLY as it does today. `getCapabilities` may be absent,
//    may not list `zoom`, and `applyConstraints` may reject; zoom has been missing from iOS
//    Safari for most of its life. A camera that fails to start is far worse than a camera that
//    cannot zoom, so every probe is wrapped, nothing throws, and nothing here is ever awaited on
//    the path the lobby gate waits for. When zoom is off - which is the default - this module does
//    not touch the track at all: no getCapabilities call, no applyConstraints, no timer.
//
// 2. Enrolment must stay at 1x. The scan builds the gallery that every phone in the room matches
//    against for the rest of the round, so a gallery captured zoomed and matched un-zoomed (or the
//    reverse) is a domain mismatch that would cost accuracy rather than buy it. "Use the same zoom
//    for both" is not actually available: galleries are shared between phones, each phone has its
//    own zoom capability and its own URL, so the scanning phone's zoom is not the matching phone's.
//    1x is the one level every phone agrees on, so that is where enrolment stays - see
//    zoomForMode. Zooming the scan would also narrow its field of view, and the scan's own gates
//    (MIN_SCAN_HEIGHT_RATIO, the aspect bounds, boxScanQuality's centring term) assume the whole
//    person fits in frame at arm's length.

// Zoom is off unless asked for. It narrows the field of view, which makes a target harder to find
// and aiming twitchier, and support is wildly inconsistent, so the conservative default is the one
// that changes nothing. `?zoom=on` picks this instead.
export const ZOOM_WHEN_ON = 2;
// Sanity bound on `?zoom=`, before the device's own range is consulted. Anything beyond this is a
// typo rather than an intent; real phones top out around 8-10x and most far lower.
export const ZOOM_PARAM_MAX = 10;

// `?zoom=2` / `?zoom=on` / `?zoom=off`. Returns the requested magnification, or null for "off",
// which is also the answer for every malformed value: a typo in the address bar must not be able
// to break the camera, and silently playing un-zoomed is the safe reading of a value nobody can
// interpret. Values below 1x would zoom *out* and shrink the very people this exists for, so they
// are rejected rather than clamped; so is exactly 1x, which is off by another name.
export function parseZoomParam(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (text === '' || text === 'off' || text === 'no' || text === '0' || text === 'false') return null;
  if (text === 'on' || text === 'yes' || text === 'true') return ZOOM_WHEN_ON;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (value <= 1 || value > ZOOM_PARAM_MAX) return null;
  return value;
}

// What zoom this screen should be at. The gameplay screen is the only one that zooms; enrolment
// and everything else stay at 1x (see the header for why this is the whole accuracy argument).
export function zoomForMode(mode, requested) {
  if (requested == null) return null;
  return mode === 'game' ? requested : 1;
}

// Fit a requested magnification into what the device actually reports. Devices disagree wildly -
// min is sometimes 1, sometimes 0.5, sometimes 100 on a scale that is not magnification at all -
// so a value outside the range clamps rather than being sent and rejected. `step` is honoured when
// the device gives one, because a value between steps is also a rejection on some drivers.
export function clampZoom(value, caps) {
  const min = Number.isFinite(caps?.min) ? caps.min : undefined;
  const max = Number.isFinite(caps?.max) ? caps.max : undefined;
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  const step = Number.isFinite(caps?.step) && caps.step > 0 ? caps.step : undefined;
  if (step !== undefined && min !== undefined) {
    next = min + Math.round((next - min) / step) * step;
    // Snapping can walk back outside the range at either end.
    if (max !== undefined) next = Math.min(max, next);
    next = Math.max(min, next);
  }
  // Drivers report steps like 0.1 that do not land on a binary fraction; without this a request of
  // 2 comes back as 2.0000000000000004 and the debug line reads like a bug.
  return Math.round(next * 1000) / 1000;
}

// ---- Applying it to a live track ----
//
// `status.state` is one of:
//   'off'         - nothing was asked for; the track was never touched
//   'applied'     - the constraint was accepted. `zoom` is what getSettings() reports.
//   'unapplied'   - accepted, but the device will not say what it did (no getSettings().zoom)
//   'unsupported' - no track, no getCapabilities, or no `zoom` in capabilities
//   'failed'      - applyConstraints rejected
//
// Nothing here throws. 'unsupported' and 'failed' are both "carry on exactly as before".

export const ZOOM_OFF = { state: 'off', requested: null, zoom: null };

// Applies `requested` to `track`, clamped to the track's reported range, and reports back what the
// *device* says happened rather than what was asked for. `requested` of null means off, and in that
// case the track is not touched at all - which is what makes the default a provable no-op.
export async function applyTrackZoom(track, requested) {
  if (requested == null) return ZOOM_OFF;
  if (!track || track.readyState === 'ended') {
    return { state: 'unsupported', requested, zoom: null, reason: 'no camera track' };
  }

  let caps;
  try {
    caps = track.getCapabilities?.();
  } catch (err) {
    // Some WebViews throw here rather than returning an empty dictionary.
    return { state: 'unsupported', requested, zoom: null, reason: `getCapabilities failed: ${err?.message || err}` };
  }
  if (!caps || !caps.zoom || !Number.isFinite(caps.zoom.max)) {
    return { state: 'unsupported', requested, zoom: null, reason: 'the camera reports no zoom range' };
  }

  const target = clampZoom(requested, caps.zoom);
  try {
    // `advanced` rather than a plain constraint on purpose: a plain `{ zoom: n }` is a *required*
    // constraint, and a required constraint the device cannot meet fails the whole call. Inside
    // `advanced` it is best-effort, so a device that half-supports zoom still gives us a stream.
    await track.applyConstraints({ advanced: [{ zoom: target }] });
  } catch (err) {
    return { state: 'failed', requested, zoom: null, reason: `applyConstraints rejected: ${err?.message || err}` };
  }

  // Read back rather than trusting `target`. A device can accept the constraint and ignore it, or
  // land on a neighbouring step, and the debug line exists to tell the field what the sensor is
  // really doing - not to echo the request back.
  let settings;
  try {
    settings = track.getSettings?.();
  } catch {
    settings = undefined;
  }
  const actual = settings?.zoom;
  if (!Number.isFinite(actual)) {
    return { state: 'unapplied', requested, zoom: null, target, reason: 'the camera does not report its zoom' };
  }
  return { state: 'applied', requested, zoom: Math.round(actual * 1000) / 1000, target };
}

// What the debug overlay's first line gains, appended to the existing `GPU+Pose+Embed+ReID`. Empty
// when zoom was never asked for, so an un-zoomed phone's line is byte-for-byte what it is today.
export function zoomStatusLabel(status) {
  const times = (value) => `${Number.isInteger(value) ? value : value.toFixed(1)}x`;
  switch (status?.state) {
    case 'applied':
      // 1x while enrolment is on screen is the deliberate state, not a failure, so it is named.
      return status.zoom > 1 ? ` zoom ${times(status.zoom)}` : ' zoom 1x';
    case 'unapplied':
      return ` zoom ${times(status.requested)}?`;
    case 'unsupported':
      return ' zoom n/a';
    case 'failed':
      return ' zoom failed';
    default:
      return '';
  }
}

// ---- Keeping the track in step with the screen ----

// Drives applyTrackZoom from the outside world without importing any of it: `getTrack` and
// `getMode` are injected, so the mode rule, the de-duplication and the serialisation are all
// testable here rather than only in a browser.
//
// sync() is idempotent and never runs two applyConstraints calls at once: applyConstraints is slow
// (it renegotiates with the camera) and a second one in flight can land out of order, so a sync
// that arrives during one records that another is wanted and runs it afterwards.
export function createZoomController({ getTrack, getMode, requested, onStatus = () => {} }) {
  let status = ZOOM_OFF;
  // The zoom level the track is believed to be at. A fresh stream starts at 1x, and saying so up
  // front is what keeps the lobby and the scan from ever issuing an applyConstraints at all: they
  // want 1x, the track is already at 1x, so nothing is sent and the capabilities are never even
  // probed until gameplay actually asks for magnification.
  let applied = 1;
  let busy = false;
  let again = false;
  // Latched once the device has said it cannot zoom. Without this the watcher probes
  // getCapabilities on every single poll for the rest of the round, which is both pointless work
  // and exactly the console spam the feature is not allowed to produce.
  let impossible = false;

  const report = (next) => {
    const changed = next.state !== status.state || next.zoom !== status.zoom;
    status = next;
    if (changed) onStatus(status);
  };

  async function run() {
    busy = true;
    try {
      do {
        again = false;
        const want = zoomForMode(getMode(), requested);
        if (want == null || want === applied) break;
        const next = await applyTrackZoom(getTrack(), want);
        if (next.state === 'applied' || next.state === 'unapplied') applied = want;
        // A device that cannot zoom will not learn how to, so stop asking. This latch is what
        // keeps the unsupported path to exactly one probe for the whole session.
        if (next.state === 'unsupported') impossible = true;
        report(next);
        if (impossible) return;
      } while (again);
    } finally {
      busy = false;
    }
  }

  return {
    // Nothing to do at all when zoom was never requested, so `enabled` is what camera.js checks
    // before it even starts a watcher.
    enabled: requested != null,
    status: () => status,
    label: () => zoomStatusLabel(status),
    sync() {
      if (requested == null || impossible) return undefined;
      if (busy) {
        again = true;
        return undefined;
      }
      return run();
    },
    // Leaving the camera behind: the next stream is a new one, starting at 1x again. The
    // `impossible` latch is deliberately *not* cleared - it is a property of the phone's camera,
    // not of this particular stream, so a rejoin should not start probing all over again.
    reset() {
      applied = 1;
      report(ZOOM_OFF);
    },
  };
}
