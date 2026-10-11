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
function arrangeScan({
  myId = SELF_ID,
  name = 'Sam',
  room = 'demo',
  reid = null,
  detector = detectionFor,
  paint = {},
  delivered = true,
} = {}) {
  const sent = [];
  dom.store.clear();
  dom.canvases.length = 0;
  dom.resetFrameHook();
  Object.assign(state, {
    name,
    room,
    myId,
    // transport.js's contract, which is what scan.js is written against: `send` resolves true
    // once the server has the message and false if it could not be delivered, and never rejects.
    // This used to be `(msg) => sent.push(msg)`, which resolves to an array length - so every
    // test here passed without the delivery reporting ever being exercised.
    conn: { send: (msg) => (sent.push(msg), Promise.resolve(delivered)) },
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

test('saving a scan clears out the old name-keyed caches', async () => {
  // A gallery is ~190 KB and nothing ever removed one, so they piled up per room *and* per name
  // until setItem threw QuotaExceededError - which saveScanCache swallows, leaving a phone that
  // silently stops remembering its scan. The version-12 entries are also the ones that may hold a
  // different player entirely, so clearing them is not only housekeeping.
  const { sent } = arrangeScan();
  dom.store.set('laser-tag:scan:demo:sam', JSON.stringify({ version: 12, name: 'Sam', gallery: [] }));
  dom.store.set('laser-tag:scan:demo:alex', JSON.stringify({ version: 12, name: 'alex', gallery: [] }));
  dom.store.set('laser-tag:scan:self:other-room', JSON.stringify({ version: 13, room: 'other-room', gallery: [] }));
  dom.store.set('laser-tag:name', 'Sam');

  await runScan(selfPlayer);
  assert.ok(sent.find((msg) => msg.type === 'scan'), 'the scan has to have succeeded for this to mean anything');

  assert.deepEqual(
    [...dom.store.keys()].filter((key) => key.startsWith('laser-tag:scan:')).sort(),
    ['laser-tag:scan:self:demo'],
    'only this room\'s own entry survives a save',
  );
  assert.equal(dom.store.get('laser-tag:name'), 'Sam', 'and nothing outside the scan keys is touched');
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

test('a frame lost during the embedding pass is skipped, not turned into a failed scan', async () => {
  // The crops behind the chosen samples live from the processing loop until the end of the OSNet
  // pass, the longest and most memory-pressured phase of the scan. OSNet answers a blank crop with
  // a perfectly ordinary unit vector - identical for every blank crop, indistinguishable from a
  // real appearance by any later check - and `reid` overrides every other field at match time, so
  // a blank one is worse than none.
  //
  // This used to throw, which failed the whole fifteen-second rotation on one bad probe. The
  // bargain now is: the lost frame contributes no vector, the colour gallery - which is what the
  // frames were already described into, before anything could be taken away - still enrols, and
  // no sample carries a `reid` built from pixels that were gone.
  let embeds = 0;
  const reid = {
    embed: async () => {
      embeds++;
      // The first embedding arrives and takes the rest of the frames away with it.
      if (embeds === 1) for (const canvas of dom.canvases) canvas.discard();
      return Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
    },
  };
  const { sent } = arrangeScan({ reid });
  await runScan(selfPlayer);

  const scanMessage = sent.find((msg) => msg.type === 'scan');
  assert.ok(
    scanMessage,
    `a lost frame must cost its own embedding, not the scan; lobby said "${dom.element('lobby-status').textContent}"`,
  );
  assert.ok(scanMessage.gallery.length >= 12, `expected a full colour gallery, got ${scanMessage.gallery.length}`);

  // The quality bar, and the whole point of keeping the probe: OSNet is asked about the one frame
  // that still had pixels and about no other. Without the check every remaining crop would be
  // embedded as a black rectangle and the vectors would look perfectly ordinary.
  assert.equal(embeds, 1, `OSNet was asked to embed ${embeds} frames, ${embeds - 1} of them discarded`);
  const withReid = scanMessage.gallery.filter((sample) => sample.reid?.length);
  assert.ok(withReid.length >= 1, 'the frame that was still intact should have produced a reid vector');
  assert.ok(
    withReid.length < scanMessage.gallery.length,
    `${withReid.length}/${scanMessage.gallery.length} samples carry a reid, so no frame was actually lost`,
  );
});

test('a frame with no red in it is not mistaken for a lost one', async () => {
  // "Is this frame still here?" has to be a question about alpha, not about colour. A recorded
  // frame is drawn from an opaque video frame, so a live one is alpha 255 everywhere whatever it
  // looks like; a discarded backing store is alpha 0. Anything that reads a colour channel
  // instead would call this cyan body - red 0 in every pixel, and a perfectly good scan - a frame
  // the browser had taken away, and fail the scan on a phone that is working fine.
  //
  // What this has to assert changed with the guard. While a lost frame *threw*, a red-reading
  // probe failed the scan outright and "a gallery was sent" caught it. Now that a lost frame is
  // merely skipped, a red-reading probe would enrol the full colour gallery with every `reid`
  // quietly missing - which the old assertions would have called a pass. So the thing to pin is
  // the re-identification vectors: every frame here is live, so every sample must carry one.
  const reid = { embed: async () => [1, 0, 0, 0, 0, 0, 0, 0] };
  const { sent } = arrangeScan({ reid, paint: { channelScale: [0, 1, 1] } });
  await runScan(selfPlayer);

  const scanMessage = sent.find((msg) => msg.type === 'scan');
  assert.ok(
    scanMessage,
    `a red-free scan must still enrol; lobby said "${dom.element('lobby-status').textContent}"`,
  );
  assert.ok(scanMessage.gallery.length >= 12);
  const withoutReid = scanMessage.gallery.filter((sample) => !sample.reid?.length).length;
  assert.equal(
    withoutReid,
    0,
    `${withoutReid}/${scanMessage.gallery.length} samples lost their reid vector, so a live frame was judged gone`,
  );
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
  // The run-token discipline, driven rather than asserted about - this replaced a test that
  // matched regexes against scan.js's source because scan.js could not then be imported. A run
  // superseded part-way through must send nothing: not its own gallery, and above all not its
  // gallery under the id of the player who replaced it, which is what this cost before the token
  // (a whole round of every phone labelling one player as another). Dropping `run === scanRun`
  // from runAutoScan's live() fails this test, which is what makes it the real guard.
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

// ---- Does the upload call compose with send()? ----
//
// `send()` resolves true once the server has the message and false if it could not be delivered;
// it retries a transient failure itself and never rejects (transport.js). `saveCurrentScan` was
// written against an older `send()` that returned nothing, so it wrapped the result in
// Promise.resolve() and attached a rejection handler - both dead against the real contract, and
// both invisible here because the harness' stub used to resolve to an array length.
//
// These two tests are the contract, from the only side the player sees: the lobby line.

test('a delivered scan is never reported as a failure', async () => {
  const { sent } = arrangeScan({ delivered: true });
  await runScan(selfPlayer);

  assert.ok(sent.find((msg) => msg.type === 'scan'), 'the gallery has to have been sent for this to mean anything');
  assert.match(
    dom.element('lobby-status').textContent,
    /^Saved scan for Sam with \d+ angles\.$/,
    'a scan the server acknowledged must keep the line that says so',
  );
});

test('a scan the connection could not deliver corrects the line that claimed it', async () => {
  // "Saved scan for <name>" used to be said whether or not the gallery ever left the phone: a
  // twelve-second rotation the player was told had worked and that no other phone ever saw.
  // Rescanning really is the only recovery - a reconnect adopts this phone's existing seat and the
  // server ignores the gallery on that path (backend/transport.py's _join), so nothing re-sends it.
  const { sent } = arrangeScan({ delivered: false });
  await runScan(selfPlayer);

  assert.ok(sent.find((msg) => msg.type === 'scan'), 'the gallery was still handed to the connection');
  assert.match(dom.element('lobby-status').textContent, /scan could not be sent/i);
  assert.match(dom.element('lobby-status').textContent, /rescan/i);
});

// ---- Exporting and importing a scan (?export) ----
//
// The feature comes from ui-redesign; what is rewritten here is where an import *goes*. The cache
// holds exactly one gallery - this phone owner's own, in this room (scan-cache.js rule 1) - so
// there is no correct slot for another player's, and writing one is the name-keyed bug by a
// shorter route: an import is the easiest possible way to end up holding a gallery you never
// captured and publishing it as your own appearance on the next join. So an import for somebody
// else is published and not cached, and the server's copy is what every phone matches against
// anyway.

// Stands in for a picked file. `text()` is the only thing importPlayerScan reads.
const exportFile = (data, name = 'scan.json') => ({ name, text: async () => JSON.stringify(data) });

// Runs a real scan of `player` and hands back the gallery that went to the server, so the imports
// below carry a gallery the quality gates actually produced.
async function galleryFor(player) {
  const { sent } = arrangeScan();
  await runScan(player);
  const message = sent.find((msg) => msg.type === 'scan');
  assert.ok(message, `no scan was produced; lobby said "${dom.element('lobby-status').textContent}"`);
  return message.gallery;
}

// `version` is written out rather than read from SCAN_CACHE_VERSION: a file whose version comes
// from the constant the import checks it against can never be the wrong version.
const exportedScan = (gallery, overrides = {}) => ({
  format: 'laser-tag-scan',
  version: 13,
  exportedAt: '2026-01-01T00:00:00.000Z',
  room: 'demo',
  player: { id: OTHER_ID, name: 'Sam' },
  sampleCount: gallery.length,
  gallery,
  ...overrides,
});

const scanKeys = () => [...dom.store.keys()].filter((key) => key.startsWith('laser-tag:scan:')).sort();

test("importing another player's scan publishes it and caches nothing", async () => {
  const gallery = await galleryFor(selfPlayer);
  // A fresh lobby with nothing cached, so "the cache is untouched" is a real claim.
  const { sent } = arrangeScan();
  assert.deepEqual(scanKeys(), [], 'precondition: nothing is cached yet');

  const message = await scan.importPlayerScan(otherSam, exportFile(exportedScan(gallery)));

  assert.match(message, /Imported \d+-angle scan for Sam/);
  const published = sent.find((msg) => msg.type === 'scan');
  assert.ok(published, 'an import has to reach the server, or no other phone can match the player');
  assert.equal(published.targetId, OTHER_ID);
  assert.deepEqual(published.gallery, gallery);

  assert.deepEqual(scanKeys(), [], "another player's gallery must never be written to this phone's cache");
  assert.equal(scan.loadScanCache(), null);
  assert.equal(state.localGallery.length, 0, "and it is not this phone's self-match guard either");
});

test('importing your OWN scan is published and cached, exactly like a finished rotation', async () => {
  const gallery = await galleryFor(selfPlayer);
  const { sent } = arrangeScan();

  const message = await scan.importPlayerScan(selfPlayer, exportFile(exportedScan(gallery)));

  assert.match(message, /Imported/, `import refused: ${message}`);
  assert.equal(sent.find((msg) => msg.type === 'scan')?.targetId, SELF_ID);
  // deepEqual, not reference: the gallery came back out of JSON, so it is a copy by construction.
  assert.deepEqual(state.localGallery, gallery, 'your own gallery is kept as the self-match guard');
  assert.deepEqual(scanKeys(), ['laser-tag:scan:self:demo'], 'and cached under the owner key, not a name');
  state.scanTargetName = '';
  assert.deepEqual(scan.loadScanCache()?.gallery, gallery, 'so a reload finds it');
});

test('an import is held to the same per-sample bar as a cached scan', async () => {
  // scan-cache.js rule 2: a sample whose vectors are all zero is not a weak sample, it is one
  // whose pixels were never read, and it scores 0 against everybody for the rest of the round.
  // The validator a *file* goes through has to be the one storage goes through, or an import is a
  // way in for samples a rotation would have thrown out.
  const gallery = await galleryFor(selfPlayer);
  const { sent } = arrangeScan();
  const blanked = gallery.map((sample, i) => (i === 3 ? { ...sample, hist: sample.hist.map(() => 0) } : sample));

  const message = await scan.importPlayerScan(selfPlayer, exportFile(exportedScan(blanked), 'blank.json'));

  assert.match(message, /does not contain a usable scan/);
  assert.equal(sent.find((msg) => msg.type === 'scan'), undefined, 'nothing may be published');
  assert.deepEqual(scanKeys(), []);
});

test('an import from an older build of the app is refused rather than matched against', async () => {
  const gallery = await galleryFor(selfPlayer);
  const { sent } = arrangeScan();

  const message = await scan.importPlayerScan(selfPlayer, exportFile(exportedScan(gallery, { version: 12 })));

  assert.match(message, /older version of the app/);
  assert.equal(sent.find((msg) => msg.type === 'scan'), undefined);
});

test('a file that is not a scan export says so instead of throwing', async () => {
  arrangeScan();
  assert.match(await scan.importPlayerScan(selfPlayer, { name: 'cat.jpg', text: async () => 'not json' }), /not a scan export/);
  assert.match(await scan.importPlayerScan(selfPlayer, exportFile({ format: 'something-else' }, 'other.json')), /not a scan export/);
});

test('an export carries the roster gallery, and the scan time only for your own scan', async () => {
  const gallery = await galleryFor(selfPlayer);
  // galleryFor left this phone's own scan in the cache, which is the only cache there is.
  const written = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    written.push(blob);
    return 'blob:scan';
  };
  URL.revokeObjectURL = () => {};
  try {
    assert.equal(scan.exportPlayerScan({ id: SELF_ID, name: 'Sam', gallery }), true);
    const own = JSON.parse(await written[0].text());
    assert.equal(own.format, 'laser-tag-scan');
    assert.deepEqual(own.gallery, gallery, 'the gallery is the roster copy every phone matches against');
    assert.ok(own.scannedAt, 'this phone took this scan, so it knows when');

    // Somebody else's row: same phone, same cache, a gallery that is not the cached one. There is
    // no slot to look their scan time up in, and no name is consulted to go looking for one.
    const theirs = gallery.map((sample) => ({ ...sample, hist: sample.hist.map((v) => v * 0.5 + 1) }));
    assert.equal(scan.exportPlayerScan({ id: OTHER_ID, name: 'Sam', gallery: theirs }), true);
    const other = JSON.parse(await written[1].text());
    assert.deepEqual(other.gallery, theirs);
    assert.equal(other.scannedAt, null, "this phone must not claim it took another player's scan");

    assert.equal(scan.exportPlayerScan({ id: OTHER_ID, name: 'Nobody', gallery: [] }), false, 'nothing to export');
    assert.equal(written.length, 2);
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
});

test('forgetting your own scan takes the one entry there is, with no name involved', async () => {
  // net.js's `scanCleared` handler. The lobby line still names the player, because that is a
  // message to a human; the cache call takes no name, because the cache has one entry and it is
  // yours. A name-keyed forget is rule 1 again: two players called Sam, and deleting one clears
  // the other's.
  await galleryFor(selfPlayer);
  assert.deepEqual(scanKeys(), ['laser-tag:scan:self:demo'], 'precondition: your scan is cached');

  scan.forgetOwnScanCache();

  assert.deepEqual(scanKeys(), [], 'the cached scan is gone, so the next join does not resend it');
  assert.equal(state.savedScan, null);
  assert.equal(scan.loadScanCache(), null);
});
