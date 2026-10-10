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
function arrangeScan({ myId = SELF_ID, name = 'Sam', room = 'demo', reid = null, detector = detectionFor, paint = {} } = {}) {
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
      paintPerson(dom.video, { ...paint, hue: (angle++ % 16) / 16 });
      callback(timestamp);
    });
  paintPerson(dom.video, { ...paint, hue: 0 });
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

test('a frame with no red in it is not mistaken for a lost one', async () => {
  // "Is this frame still here?" has to be a question about alpha, not about colour. A recorded
  // frame is drawn from an opaque video frame, so a live one is alpha 255 everywhere whatever it
  // looks like; a discarded backing store is alpha 0. Anything that reads a colour channel
  // instead would call this cyan body - red 0 in every pixel, and a perfectly good scan - a frame
  // the browser had taken away, and fail the scan on a phone that is working fine.
  const reid = { embed: async () => [1, 0, 0, 0, 0, 0, 0, 0] };
  const { sent } = arrangeScan({ reid, paint: { channelScale: [0, 1, 1] } });
  await runScan(selfPlayer);

  const scanMessage = sent.find((msg) => msg.type === 'scan');
  assert.ok(
    scanMessage,
    `a red-free scan must still enrol; lobby said "${dom.element('lobby-status').textContent}"`,
  );
  assert.ok(scanMessage.gallery.length >= 12);
});

test('only the frames behind the chosen samples are still alive during the embedding pass', async () => {
  // The memory half of the same bug, measured where it matters. ~60 recorded canvases are ~140 MB
  // at phone resolutions, and the embedding pass is the longest phase of the scan and the one
  // running under the most pressure - so what counts is not how much is freed by the end but how
  // much is still resident *then*. Selection has to keep the frames behind the chosen samples
  // (that is the whole point of deferring OSNet) and nothing else.
  let liveDuringEmbed = 0;
  let embedded = 0;
  const reid = {
    embed: async () => {
      embedded++;
      liveDuringEmbed = Math.max(liveDuringEmbed, dom.canvases.reduce((bytes, canvas) => bytes + canvas.byteLength, 0));
      return [1, 0, 0, 0, 0, 0, 0, 0];
    },
  };
  const { sent } = arrangeScan({ reid });
  await runScan(selfPlayer);
  assert.ok(sent.find((msg) => msg.type === 'scan'), 'the scan has to have succeeded for this to mean anything');

  const fullFrameBytes = 640 * 360 * 4;
  const recorded = dom.canvases.filter((canvas) => canvas.peakBytes === fullFrameBytes).length;
  // The box this test's detector reports, which is what a crop of it costs.
  const cropBytes = Math.round(640 * 0.3) * Math.round(360 * 0.8) * 4;
  assert.ok(recorded >= 12, 'expected a real recording');
  assert.ok(embedded > 0, 'the embedding pass never ran, so this measured nothing');
  assert.ok(
    recorded > embedded * 2,
    `the pass embeds ${embedded} of ${recorded} frames, which is not enough of a difference for this to test anything`,
  );

  // The ceiling is the frames the pass actually reads, plus a couple of reused scratch canvases
  // (the 512-wide detection copy and the 32x48 stats canvas) - and emphatically *not* one per
  // usable frame. Expressed against `embedded` rather than as a fraction of the recording,
  // because a fraction was loose enough to pass with every candidate's crop still alive.
  const ceiling = (embedded + 4) * cropBytes;
  assert.ok(
    liveDuringEmbed < ceiling,
    `${(liveDuringEmbed / 1e6).toFixed(2)} MB live while embedding ${embedded} frames (ceiling ${(ceiling / 1e6).toFixed(2)} MB); ` +
      `${recorded} frames were recorded, ${((recorded * fullFrameBytes) / 1e6).toFixed(1)} MB`,
  );
});

test('starting a second scan mid-flight enrols exactly one gallery, under the right id', async () => {
  // The run-token discipline, driven rather than asserted about. test/scan-run-token.test.js pins
  // the shape of the fix in the source and says plainly that it cannot do this; now something
  // can. A run superseded part-way through must send nothing - not its own gallery, and above all
  // not its gallery under the id of the player who replaced it, which is what this cost before
  // the token (a whole round of every phone labelling one player as another).
  const { sent } = arrangeScan();
  scan.beginPlayerScan(selfPlayer);
  await dom.pump(30);
  scan.beginPlayerScan(otherSam);
  await dom.flush();

  const scans = sent.filter((msg) => msg.type === 'scan');
  assert.equal(scans.length, 1, `expected one gallery, got ${scans.length}`);
  assert.equal(scans[0].targetId, OTHER_ID, 'the live run owns the scan');
  // The superseded run was scanning the local player, so a gallery leaking out of it would also
  // have left its mark here.
  assert.equal(state.localGallery.length, 0, 'the abandoned run must not have set a self gallery');
  state.scanTargetName = '';
  assert.equal(scan.loadScanCache(), null, 'and must not have cached one either');
});

test('the quality gate judges the pixels the signature is actually built from', async () => {
  // A box may overhang the frame edge and still be worth enrolling, as long as it is tall enough
  // (CLIPPED_OK_SCAN_HEIGHT_RATIO). identify.js's readPixels clips such a box by subtracting the
  // part that fell outside; scanImageStats subtracted nothing, so for an overhanging box the gate
  // measured a window *shifted* inwards - wider, and over pixels the signature never saw.
  //
  // Here the box hangs 25% of the frame off the left edge *and* off the top, so the corner of it
  // that is actually inside the frame is flat paint and everything beyond it is textured. The
  // signature is built from that corner, so the frame has nothing in it worth enrolling and the
  // gate must say so. Measuring a shifted window instead - in either axis; the bug was in both -
  // finds the texture next door and enrols a frame of flat wall.
  const flatWidth = 20;
  const flatHeight = 185;
  const paintFlatCorner = (canvas) => {
    const { width: w, height: h, pixels } = canvas;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = Math.sin((x * 12.9898 + y * 78.233) * 1.7) * 43_758.545;
        const flat = x < flatWidth && y < flatHeight;
        const noise = flat ? 0 : (n - Math.floor(n)) * 90 - 45;
        pixels[i] = Math.max(0, Math.min(255, 120 + noise));
        pixels[i + 1] = Math.max(0, Math.min(255, 120 + noise));
        pixels[i + 2] = Math.max(0, Math.min(255, 120 - noise));
        pixels[i + 3] = 255;
      }
    }
  };

  const overhanging = (source) => {
    const w = source.videoWidth || source.width;
    const h = source.videoHeight || source.height;
    return {
      detections: [
        {
          boundingBox: { originX: -Math.round(w * 0.25), originY: -Math.round(h * 0.25), width: Math.round(w * 0.3), height: Math.round(h * 0.8) },
          categories: [{ score: 0.9 }],
        },
      ],
    };
  };

  const { sent } = arrangeScan({ detector: overhanging });
  // Replace arrangeScan's rotating person: this frame has to stay exactly as described.
  dom.resetFrameHook();
  const rAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) =>
    rAF((timestamp) => {
      paintFlatCorner(dom.video);
      callback(timestamp);
    });
  paintFlatCorner(dom.video);

  await runScan(selfPlayer);

  assert.equal(
    sent.find((msg) => msg.type === 'scan'),
    undefined,
    'a box whose visible part is flat paint must not enrol, whatever is next to it',
  );
  assert.match(dom.element('lobby-status').textContent, /usable angles/i);
  assert.match(dom.element('lobby-status').textContent, /flat background|brighter light/i);
});

test('the debug overlay counts embeddings that happened, not embedders that exist', async () => {
  // `if (state.embedder) scanCost.embedInferences++` overcounts: personEmbedding returns [] without
  // inferring at all when there is no usable region or the inference threw. The ?debug overlay is
  // the only place anyone reads these numbers, and a number that is really "frames processed"
  // dressed up as "inferences" is worse than no number.
  const embedderThatNeverAnswers = { embedForVideo: () => ({ embeddings: [{}] }) };
  const { sent } = arrangeScan();
  state.embedder = embedderThatNeverAnswers;
  await runScan(selfPlayer);

  assert.ok(sent.find((msg) => msg.type === 'scan'), 'an embedder that returns nothing still enrols a colour gallery');
  assert.match(scan.scanCostLine(), /\bembed 0\b/, scan.scanCostLine());

  // ...and when it does answer, they are counted.
  const embedderThatAnswers = {
    embedForVideo: () => ({ embeddings: [{ floatEmbedding: Array.from({ length: 16 }, (_, i) => (i + 1) / 16) }] }),
  };
  const second = arrangeScan();
  state.embedder = embedderThatAnswers;
  await runScan(selfPlayer);
  assert.ok(second.sent.find((msg) => msg.type === 'scan'));
  const counted = Number(scan.scanCostLine().match(/\bembed (\d+)\b/)[1]);
  const usable = Number(scan.scanCostLine().match(/Scan (\d+)\//)[1]);
  assert.ok(counted > 0, scan.scanCostLine());
  assert.equal(counted, usable, 'one embedding per usable frame, no more and no fewer');
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

test('a scan abandoned before it starts leaves no numbers from the scan before it', async () => {
  // runAutoScan resets the cost counters, but it only runs a paint later (afterNextPaint), so a
  // scan the player backs out of before then never reached the reset - and the ?debug overlay
  // went on describing the previous scan as though it were this one.
  const { sent } = arrangeScan();
  await runScan(selfPlayer);
  assert.ok(sent.find((msg) => msg.type === 'scan'));
  assert.match(scan.scanCostLine(), /Scan \d+\/\d+ usable/, 'a finished scan should have put numbers on the overlay');

  scan.beginPlayerScan(otherSam);
  scan.cancelScan(); // before the two animation frames beginPlayerScan waits for
  await dom.flush();
  assert.equal(scan.scanCostLine(), '', `the overlay still reads: ${scan.scanCostLine()}`);
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
