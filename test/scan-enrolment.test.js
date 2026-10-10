// A whole scan, driven for real: `beginPlayerScan` through the countdown, the twelve-second
// recording, the per-frame quality gates, identify.js's signature extraction, selection, the
// re-identification pass, and what ends up sent and cached.
//
// This is possible at all because of test/helpers/vendor-hooks.js (which maps the front end's one
// absolute-URL import onto a stub) and test/helpers/fake-dom.js (which gives env.js the DOM it
// reaches at module scope, and models a canvas faithfully enough to *discard* one the way iOS
// does). Before them, `screens/scan.js` could not be imported under Node at all, which is why the
// bugs below were only ever reasoned about.
//
// What is real here: scan.js, scan-select.js, scan-cache.js, identify.js, detector.js's box
// plumbing, and every threshold. What is faked: the camera's pixels, the object detector's
// answer, the OSNet embedder, and the clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { installFakeDom, paintPerson } from './helpers/fake-dom.js';

register('./helpers/vendor-hooks.js', import.meta.url);

// The DOM has to exist before env.js is evaluated, and ESM evaluates on first import - so the
// modules are loaded once, here, against one long-lived fake DOM, and each test resets `state`.
const dom = installFakeDom({ videoWidth: 640, videoHeight: 360 });
const scan = await import('../frontend/public/screens/scan.js');
const { state } = await import('../frontend/public/state.js');

const SELF_ID = 'self-uuid-0001';
const OTHER_ID = 'other-uuid-0002';

/** A box 30% of the frame wide and 80% tall, in whatever space the detector was handed. */
function detectionFor(source) {
  const w = source.videoWidth || source.width;
  const h = source.videoHeight || source.height;
  return {
    detections: [
      {
        boundingBox: { originX: Math.round(w * 0.35), originY: Math.round(h * 0.1), width: Math.round(w * 0.3), height: Math.round(h * 0.8) },
        categories: [{ score: 0.9 }],
      },
    ],
  };
}

/**
 * Puts `state` in the shape it has when a lobby row's Scan button is tapped, and repaints the
 * camera on every animation frame so the twelve seconds of recording produce frames that differ
 * from each other, as a real rotation does.
 */
function arrangeScan({ myId = SELF_ID, name = 'Sam', room = 'demo', reid = null, detector = detectionFor } = {}) {
  const sent = [];
  dom.store.clear();
  dom.canvases.length = 0;
  dom.resetFrameHook();
  Object.assign(state, {
    name,
    room,
    myId,
    conn: { send: (msg) => sent.push(msg) },
    roster: [
      { id: SELF_ID, name: 'Sam', gallery: [] },
      { id: OTHER_ID, name: 'Sam', gallery: [] },
    ],
    game: null,
    detector: { detectForVideo: (source) => detector(source) },
    poseDetector: null,
    embedder: null,
    reid,
    gallery: [],
    localGallery: [],
    savedScan: null,
    scanTargetId: null,
    scanTargetName: '',
    autoScanning: false,
    recordingScan: false,
    postProcessingScan: false,
    mode: 'lobby',
    boxes: [],
  });

  // One turn of the rotation across the recording, so the frames are not all identical.
  let angle = 0;
  const rAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) =>
    rAF((timestamp) => {
      paintPerson(dom.video, { hue: (angle++ % 16) / 16 });
      callback(timestamp);
    });
  paintPerson(dom.video, { hue: 0 });
  return { sent };
}

/** Runs one whole scan of `player` and settles every queued frame and timer. */
async function runScan(player) {
  scan.beginPlayerScan(player);
  await dom.flush();
}

const selfPlayer = { id: SELF_ID, name: 'Sam' };
const otherSam = { id: OTHER_ID, name: 'Sam' };

test('a scan of your own body is sent under your id and cached for the next reload', async () => {
  const { sent } = arrangeScan();
  await runScan(selfPlayer);

  const scanMessage = sent.find((msg) => msg.type === 'scan');
  assert.ok(scanMessage, `no scan was sent; lobby said "${dom.element('lobby-status').textContent}"`);
  assert.equal(scanMessage.targetId, SELF_ID);
  assert.ok(scanMessage.gallery.length >= 12, `expected a full gallery, got ${scanMessage.gallery.length} angles`);
  assert.equal(state.localGallery, scanMessage.gallery, 'your own gallery is kept as the self-match guard');

  // ...and a reload finds it again. loadScanCache() is what join.js calls, with scanTargetName
  // cleared, which is the exact call the name-keyed bug went wrong on.
  state.scanTargetName = '';
  const cached = scan.loadScanCache();
  assert.ok(cached, 'the scan was not cached');
  assert.deepEqual(cached.gallery, scanMessage.gallery);
});

test('scanning another player who shares your name does not touch your own cache', async () => {
  // The bug, end to end. You are Sam; the other player in the room is also Sam. The slot used to
  // be `scan:<room>:<lower-cased name>` and the validator compared `cache.name`, so this scan
  // wrote the other Sam's gallery where your own belongs - and the next rejoin published her
  // appearance as yours, to every phone in the room, for the whole round.
  const { sent } = arrangeScan();
  await runScan(otherSam);

  const scanMessage = sent.find((msg) => msg.type === 'scan');
  assert.ok(scanMessage, 'the scan of the other player still has to be sent to the server');
  assert.equal(scanMessage.targetId, OTHER_ID);
  assert.notEqual(state.localGallery, scanMessage.gallery, "another player's gallery is not yours");
  assert.equal(state.localGallery.length, 0);

  state.scanTargetName = '';
  assert.equal(scan.loadScanCache(), null, "another player's scan must not come back as your own");
  assert.deepEqual([...dom.store.keys()].filter((key) => key.includes('scan')), [], 'nothing was cached at all');
});

test('your own cache survives a rename, because the name was never the identity', async () => {
  const { sent } = arrangeScan({ name: 'Sam' });
  await runScan(selfPlayer);
  const gallery = sent.find((msg) => msg.type === 'scan').gallery;

  // Same phone, same room, same body, different display name - which under the old key was a
  // different slot entirely, so the scan was silently lost and the player rotated again.
  state.name = 'Samantha';
  state.scanTargetName = '';
  assert.deepEqual(scan.loadScanCache()?.gallery, gallery);

  // Case, too: the key lower-cased the name and the validator compared it case-sensitively, so
  // "Alex" and "alex" shared one slot and each invalidated the other's cache.
  state.name = 'SAM';
  assert.deepEqual(scan.loadScanCache()?.gallery, gallery);
});

test('a cache from another room is not used in this one', async () => {
  const { sent } = arrangeScan({ room: 'demo' });
  await runScan(selfPlayer);
  assert.ok(sent.find((msg) => msg.type === 'scan'));

  state.room = 'elsewhere';
  state.scanTargetName = '';
  assert.equal(scan.loadScanCache(), null);
});

test('a scan whose recorded frames the browser discarded enrols nothing', async () => {
  // Memory pressure, modelled exactly as iOS does it: the canvases are still live objects, but
  // drawImage from them paints nothing and reading them back gives transparent black. Every
  // recorded frame is discarded the moment it is captured, so the whole rotation is blank.
  const { sent } = arrangeScan();
  const rAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) =>
    rAF((timestamp) => {
      callback(timestamp);
      for (const canvas of dom.canvases) canvas.discard();
    });

  await runScan(selfPlayer);

  assert.equal(sent.find((msg) => msg.type === 'scan'), undefined, 'a blank rotation must not enrol');
  assert.equal(state.localGallery.length, 0);
  assert.deepEqual([...dom.store.keys()].filter((key) => key.includes('scan')), [], 'and must not be cached');
  // It also has to *say* something: the player is owed a reason, not a lobby that looks like it
  // worked. (Blank frames fail the brightness gate first, so the reason is the light.)
  assert.match(dom.element('lobby-status').textContent, /usable angles|could not/i);
});

test('a frame lost between selection and the embedding pass fails the scan loudly', async () => {
  // The window the audit missed, and the one that actually matters: the crops behind the chosen
  // samples live from the processing loop until the end of the OSNet pass, which is the longest
  // and most memory-pressured phase of the scan. OSNet answers a blank crop with a perfectly
  // ordinary unit vector - identical for every blank crop, indistinguishable from a real
  // appearance by any later check - so the gallery would have been cached and matched against for
  // the rest of the round. Nothing but looking at the pixels catches it.
  let embeds = 0;
  const reid = {
    embed: async (image) => {
      embeds++;
      // The second embedding arrives to find the rest of the frames gone.
      if (embeds === 1) for (const canvas of dom.canvases) canvas.discard();
      return Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
    },
  };
  const { sent } = arrangeScan({ reid });
  await runScan(selfPlayer);

  assert.ok(embeds > 0, 'the embedding pass never ran, so this test proved nothing');
  assert.equal(sent.find((msg) => msg.type === 'scan'), undefined, 'a scan with a lost frame must not enrol');
  assert.deepEqual([...dom.store.keys()].filter((key) => key.includes('scan')), [], 'and must not be cached');
  assert.match(dom.element('lobby-status').textContent, /could not process the rotation video/i);
  assert.match(dom.element('lobby-status').textContent, /discarded a recorded frame/i);
});

test('every gallery sample carries real, non-degenerate vectors', async () => {
  // The silent failure this whole area is about is a sample that validates and scores 0 against
  // everybody. Nothing weaker than looking at the numbers catches it.
  const { sent } = arrangeScan();
  await runScan(selfPlayer);
  const gallery = sent.find((msg) => msg.type === 'scan').gallery;

  for (const [i, sample] of gallery.entries()) {
    for (const field of ['hist', 'lower', 'grid', 'shape']) {
      assert.ok(Array.isArray(sample[field]) && sample[field].length, `sample ${i} has no ${field}`);
      assert.ok(sample[field].every(Number.isFinite), `sample ${i} ${field} is not finite`);
      assert.ok(sample[field].some((v) => v !== 0), `sample ${i} ${field} is all zero`);
    }
  }
});

test('the recorded frames are released as they are described, not held to the end', async () => {
  // ~60 canvases of 1024x576x4 B is ~140 MB, held from capture until the end of the embedding
  // pass - which is what iOS was responding to by discarding them. A frame is now released as
  // soon as it has been described, and a usable one is replaced by a crop of just its person box
  // first, because that crop is what the embedding pass still needs after selection.
  const { sent } = arrangeScan();
  await runScan(selfPlayer);
  assert.ok(sent.find((msg) => msg.type === 'scan'), 'the scan has to have succeeded for this to mean anything');

  const fullFrameBytes = 640 * 360 * 4;
  const recorded = dom.canvases.filter((canvas) => canvas.peakBytes === fullFrameBytes);
  assert.ok(recorded.length >= 12, `expected a real recording, saw ${recorded.length} full-size frames`);
  assert.deepEqual(
    recorded.filter((canvas) => canvas.byteLength === fullFrameBytes).length,
    0,
    'no recorded frame may still be holding its backing store once the scan is over',
  );
  const live = dom.canvases.reduce((bytes, canvas) => bytes + canvas.byteLength, 0);
  assert.ok(
    live < fullFrameBytes * 2,
    `${(live / 1e6).toFixed(2)} MB of canvas still live after the scan, out of ${((recorded.length * fullFrameBytes) / 1e6).toFixed(1)} MB recorded`,
  );
});

test('cancelling mid-scan sends nothing, caches nothing and says so', async () => {
  const { sent } = arrangeScan();
  scan.beginPlayerScan(selfPlayer);
  // Let the countdown start, then cancel the way the X does.
  await dom.pump(40);
  scan.cancelScan();
  await dom.flush();

  assert.equal(sent.find((msg) => msg.type === 'scan'), undefined);
  assert.deepEqual([...dom.store.keys()].filter((key) => key.includes('scan')), []);
  assert.equal(dom.element('lobby-status').textContent, 'Scan cancelled.');
  assert.equal(state.autoScanning, false);
  assert.equal(state.recordingScan, false);
});
