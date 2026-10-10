// Dead frontend code, moved out of public/screens/scan.js, public/roster.js and
// public/detector.js (paths as of when this game still had public/ at the repo root - it has
// since been merged into frontend/public/).
//
// This is not imported by anything and will not run as-is (the imports below are not kept
// up to date with the live modules). It's kept only so the manual single-capture scan flow
// this game used before the automatic "stand and rotate one circle" flow isn't lost to history.
//
// Originally, scanning worked by repeatedly tapping a "Capture" button: each tap ran
// captureScanSignature(), which sampled a handful of frames, picked the best one, and handed it
// to recordScanCapture() to push onto the gallery. clearScanCache()/useSavedScan() supported a
// debug convenience where a previous scan could be reused or wiped without rescanning. None of
// index.html's buttons call any of this any more - it was superseded wholesale by the rotation-
// recording flow in scan.js (runAutoScan() etc.), which captures a short video while the player
// turns once and automatically selects the best-angled frames from it instead of relying on
// manual taps.
//
// Also included: hasScan() (public/roster.js) and the no-op updateScanButtons()/
// renderSavedScan() functions (public/screens/scan.js) - all three had zero callers/effect by
// the time this was found, left over from the same UI that used this capture flow.

// ---- from public/roster.js ----

export function hasScan(player) {
  return Boolean(player.gallery?.length);
}

// ---- from public/screens/scan.js ----
// (updateScanButtons/renderSavedScan were no-ops called from several places in the live scan
// flow; those call sites were removed along with the functions, not moved here.)

function updateScanButtons() {}

function renderSavedScan() {}

function useSavedScan() {
  if (!state.savedScan) return;
  setScanGallery(state.savedScan.gallery, state.savedScan.thumbs ?? []);
  startScanStep();
}

function clearScanCache() {
  try {
    localStorage.removeItem(`laser-tag:${scanCacheKey()}`);
  } catch {
    // Ignore storage errors; clearing the in-memory copy is enough for this run.
  }
  state.savedScan = null;
  state.autoScanning = false;
  state.postProcessingScan = false;
  state.gallery = [];
  state.scanThumbs = [];
  $('scan-thumbs').innerHTML = '';
  startScanStep();
}

function recordScanCapture(captured) {
  if (state.gallery.length >= SCAN_TARGET_SAMPLES) return;
  state.gallery.push(captured.signature);
  const thumb = cropThumbnail(captured.box);
  state.scanThumbs.push(thumb);
  appendScanThumb(thumb);
  startScanStep();
  saveScanCache();
}

function currentScanBoxes(timestamp = performance.now()) {
  const boxes = detectScanPeople(state.detector, state.poseDetector, video, timestamp);
  state.boxes = boxes;
  return boxes;
}

async function captureScanSignature() {
  const samples = [];
  let thumbnailBox = null;
  let problem = 'no-person';
  for (let i = 0; i < SCAN_SAMPLE_COUNT; i++) {
    await nextFrame();
    const now = performance.now();
    const candidate = bestUsableScanCandidate(currentScanBoxes(now), video);
    const box = candidate.box;
    if (box && candidate.problem === 'ok' && usableScanBox(video, box)) {
      const signature = extractSignature(video, box, state.embedder, now);
      if (state.reid) signature.reid = await state.reid.embed(video, box);
      samples.push(signature);
      thumbnailBox = box;
      problem = 'ok';
    } else {
      problem = candidate.problem ?? scanBoxProblem(video, box);
    }
    if (i < SCAN_SAMPLE_COUNT - 1) await wait(SCAN_SAMPLE_INTERVAL_MS);
  }
  return samples.length >= Math.ceil(SCAN_SAMPLE_COUNT / 2)
    ? { signature: averageSignatures(samples), box: thumbnailBox }
    : { problem };
}

// ---- from public/detector.js ----
// contains()/headBox()/bodyBox() are still live (used directly by motion-identity.js's
// targetUnderCrosshair-equivalent); only this convenience wrapper around them was unused.

function hitTest(boxes, px, py) {
  let zone = null;
  for (const box of boxes) {
    if (contains(headBox(box), px, py)) return 'head';
    if (contains(bodyBox(box), px, py)) zone = 'body';
  }
  return zone;
}
