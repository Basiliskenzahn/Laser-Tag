// What the player waits for on the way into the lobby (frontend/public/startup.js).
//
// Every test here is about *ordering*, so every model is a deferred promise that only resolves
// when the test says so. That is the point: a test that merely checked the models all arrive would
// still pass if someone put the optional three back on the critical path, which is the bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONAL_MODELS, beginStartup, markLobbyVisible, startupTimingLine, timings } from '../frontend/public/startup.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Lets the microtask queue drain, so "has this promise settled yet?" is a fair question.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A startup where the test holds every single piece open. `clock` is a hand-cranked
// performance.now() so the recorded durations are deterministic.
function harness({ delegate = 'GPU' } = {}) {
  const gates = {
    camera: deferred(),
    fileset: deferred(),
    object: deferred(),
    poseDetector: deferred(),
    embedder: deferred(),
    reid: deferred(),
  };
  const started = [];
  const landed = [];
  const warmed = [];
  let clock = 0;

  const startup = beginStartup({
    startCamera: () => gates.camera.promise,
    createFileset: () => gates.fileset.promise,
    createObjectDetector: () => {
      started.push('object');
      return gates.object.promise;
    },
    createPoseDetector: (fileset, got) => {
      started.push(`poseDetector:${got}`);
      return gates.poseDetector.promise;
    },
    createEmbedder: (fileset, got) => {
      started.push(`embedder:${got}`);
      return gates.embedder.promise;
    },
    createReid: () => {
      started.push('reid');
      return gates.reid.promise;
    },
    onModel: (name, model) => landed.push([name, model]),
    warmUp: (name) => warmed.push(name),
    now: () => clock,
  });

  return {
    startup,
    gates,
    started,
    landed,
    warmed,
    tick: (ms) => {
      clock += ms;
    },
    // The two gates the lobby is allowed to wait for.
    async openRequired() {
      gates.fileset.resolve('fileset');
      gates.camera.resolve();
      await settle();
      gates.object.resolve({ detector: 'object-detector', delegate });
      await settle();
    },
  };
}

test('the lobby gate is camera + object detector, and nothing else', async () => {
  const h = harness();
  let ready = false;
  h.startup.ready.then(() => {
    ready = true;
  });

  await settle();
  assert.equal(ready, false, 'nothing has resolved yet');

  await h.openRequired();
  assert.equal(ready, true, 'camera and the object detector are enough');

  // The regression this exists for: if someone puts the optional models back in front of the
  // lobby, they are still unresolved here and `ready` above would have been false.
  for (const name of OPTIONAL_MODELS) {
    assert.ok(
      !h.landed.some(([landedName]) => landedName === name),
      `${name} must not have been required for the lobby`,
    );
  }
});

test('the gate does not wait for the camera alone, nor the detector alone', async () => {
  const cameraOnly = harness();
  let ready = false;
  cameraOnly.startup.ready.then(() => {
    ready = true;
  });
  cameraOnly.gates.camera.resolve();
  cameraOnly.gates.fileset.resolve('fileset');
  await settle();
  assert.equal(ready, false, 'the object detector is still required');

  const detectorOnly = harness();
  let detectorReady = false;
  detectorOnly.startup.ready.then(() => {
    detectorReady = true;
  });
  detectorOnly.gates.fileset.resolve('fileset');
  await settle();
  detectorOnly.gates.object.resolve({ detector: 'd', delegate: 'GPU' });
  await settle();
  assert.equal(detectorReady, false, 'the camera is still required');
});

test('pose and the embedder are created in parallel with each other', async () => {
  const h = harness();
  await h.openRequired();

  // Both were started off the same delegate answer, so both are in flight at once. A serial
  // implementation would only have started the first of them.
  assert.ok(h.started.includes('poseDetector:GPU'), 'pose started');
  assert.ok(h.started.includes('embedder:GPU'), 'embedder started');

  // ...and neither has resolved, so the second did not have to wait for the first.
  let poseDone = false;
  let embedDone = false;
  h.startup.models.poseDetector.then(() => {
    poseDone = true;
  });
  h.startup.models.embedder.then(() => {
    embedDone = true;
  });
  await settle();
  assert.deepEqual([poseDone, embedDone], [false, false]);

  // Resolve them out of order: a serialised version could not deliver the embedder first.
  h.gates.embedder.resolve('embedder');
  await settle();
  assert.deepEqual([poseDone, embedDone], [false, true], 'the embedder landed while pose was still loading');
});

test('neither pose nor the embedder starts before the delegate is known', async () => {
  const h = harness();
  h.gates.fileset.resolve('fileset');
  h.gates.camera.resolve();
  await settle();

  assert.deepEqual(
    h.started.filter((name) => name.startsWith('poseDetector') || name.startsWith('embedder')),
    [],
    'the delegate decision is a real dependency and must still be respected',
  );

  h.gates.object.resolve({ detector: 'd', delegate: 'CPU' });
  await settle();
  assert.deepEqual(h.started.filter((n) => n.includes(':')).sort(), ['embedder:CPU', 'poseDetector:CPU']);
});

test('a GPU fallback puts every model on CPU, never a mixture', async () => {
  const h = harness({ delegate: 'CPU' });
  await h.openRequired();
  const delegates = h.started.filter((name) => name.includes(':')).map((name) => name.split(':')[1]);
  assert.deepEqual([...new Set(delegates)], ['CPU'], 'all optional models share the object detector delegate');
});

test('re-identification does not wait for the MediaPipe bundle or the delegate', async () => {
  const h = harness();
  // Nothing resolved at all yet, and OSNet is already downloading: it is ONNX Runtime, so it
  // shares neither the wasm fileset nor the delegate.
  await settle();
  assert.ok(h.started.includes('reid'));

  h.gates.reid.resolve('osnet');
  await settle();
  assert.deepEqual(h.landed, [['reid', 'osnet']]);
});

test('optional models land and are warmed whenever they arrive, including after the lobby', async () => {
  const h = harness();
  await h.openRequired();
  assert.deepEqual(h.landed, [], 'nothing optional has arrived yet, and the lobby is already open');

  h.gates.embedder.resolve('mobilenet');
  await settle();
  assert.deepEqual(h.landed, [['embedder', 'mobilenet']]);
  assert.deepEqual(h.warmed, ['embedder'], 'a late model still gets its throwaway inference');

  h.gates.poseDetector.resolve('pose');
  h.gates.reid.resolve('osnet');
  await settle();
  assert.deepEqual(h.landed.map(([name]) => name).sort(), ['embedder', 'poseDetector', 'reid']);
  assert.deepEqual(h.warmed.sort(), ['embedder', 'poseDetector', 'reid']);
});

test('a model that fails lands as null, is not warmed, and does not reject the gate', async () => {
  const h = harness();
  let ready = null;
  h.startup.ready.then((value) => {
    ready = value;
  });

  // Rejected only once startup has actually called the factories, which is when a real create()
  // can fail: before that it has not been asked for anything yet.
  await h.openRequired();
  // Two different ways to fail: detector.js returns null for a model it could not create, and a
  // model that throws anyway must be caught rather than poisoning the chain the scan path awaits.
  h.gates.poseDetector.resolve(null);
  h.gates.embedder.reject(new Error('no WebGL for you'));
  h.gates.reid.reject(new Error('onnx unavailable'));
  await h.startup.models.all;

  assert.deepEqual(ready, { detector: 'object-detector', delegate: 'GPU' }, 'the gate still opened');
  assert.deepEqual(
    Object.fromEntries(h.landed),
    { poseDetector: null, embedder: null, reid: null },
    'the best-effort contract: a slot the phone could not fill is null',
  );
  assert.deepEqual(h.warmed, [], 'there is nothing to warm up');
});

test('models.all resolves once nothing is loading, even when everything failed', async () => {
  const h = harness();
  await h.openRequired();
  let all = false;
  h.startup.models.all.then(() => {
    all = true;
  });
  await settle();
  assert.equal(all, false);

  h.gates.poseDetector.resolve(null);
  h.gates.embedder.reject(new Error('nope'));
  h.gates.reid.resolve(null);
  await h.startup.models.all;
  assert.equal(all, true);
});

test('a failed camera rejects the gate, because that is the one failure the player can fix', async () => {
  const h = harness();
  h.gates.fileset.resolve('fileset');
  h.gates.object.resolve({ detector: 'd', delegate: 'GPU' });
  h.gates.camera.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  await assert.rejects(h.startup.ready, /denied/);
});

test('the timings record each step separately, and the two totals', async () => {
  const h = harness();
  h.tick(100);
  h.gates.fileset.resolve('fileset');
  h.gates.camera.resolve();
  await settle();
  assert.equal(timings.fileset, 100, 'measured from the start of startup');
  assert.equal(timings.camera, 100);

  h.tick(900);
  h.gates.object.resolve({ detector: 'd', delegate: 'GPU' });
  await settle();
  assert.equal(timings.detector, 900, "the object detector's own load, not a total");

  // Pose and the embedder are in flight together, so their own durations overlap in wall-clock
  // terms - which is exactly what the parallel creation buys.
  h.tick(400);
  h.gates.embedder.resolve('m');
  await settle();
  h.tick(200);
  h.gates.poseDetector.resolve('p');
  h.gates.reid.resolve('r');
  await settle();
  assert.equal(timings.embedder, 400);
  assert.equal(timings.poseDetector, 600);

  markLobbyVisible(() => 1200);
  await h.startup.models.all;
  assert.equal(timings.lobby, 1200);
  assert.equal(timings.all, 1600);

  const line = startupTimingLine();
  assert.match(line, /^Startup /);
  assert.match(line, /obj 900ms/);
  assert.match(line, /lobby 1\.2s/);
  assert.match(line, /all 1\.6s/);
});

test('the timing line is empty before anything has loaded', () => {
  beginStartup({
    startCamera: () => deferred().promise,
    createFileset: () => deferred().promise,
    createObjectDetector: () => deferred().promise,
    createPoseDetector: () => deferred().promise,
    createEmbedder: () => deferred().promise,
    createReid: () => deferred().promise,
    now: () => 0,
  });
  assert.equal(startupTimingLine(), '');
});
