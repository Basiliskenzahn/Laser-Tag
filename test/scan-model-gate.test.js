// What enrolment waits for before it starts recording (frontend/public/startup.js's `pending`
// and `waitForOptional`, wired up in camera.js and called by screens/scan.js).
//
// The point of the whole startup change is that the lobby no longer waits for the embedder or the
// recogniser. The cost of that is this: a scan could begin before they arrive, and a scan that
// runs without them does not fail - it quietly enrols *weaker* signatures, which are then cached
// under SCAN_CACHE_VERSION and matched against by every phone for the rest of the round. So the
// wait moved from the join screen (where it was unnecessary) to the one place that needs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginStartup } from '../frontend/public/startup.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const gates = {
    camera: deferred(),
    fileset: deferred(),
    object: deferred(),
    poseDetector: deferred(),
    embedder: deferred(),
    reid: deferred(),
  };
  const landed = {};
  const startup = beginStartup({
    startCamera: () => gates.camera.promise,
    createFileset: () => gates.fileset.promise,
    createObjectDetector: () => gates.object.promise,
    createPoseDetector: () => gates.poseDetector.promise,
    createEmbedder: () => gates.embedder.promise,
    createReid: () => gates.reid.promise,
    onModel: (name, model) => {
      landed[name] = model;
    },
    now: () => 0,
  });
  return {
    startup,
    gates,
    landed,
    async openLobby() {
      gates.fileset.resolve('fileset');
      gates.camera.resolve();
      await settle();
      gates.object.resolve({ detector: 'object-detector', delegate: 'GPU' });
      await settle();
    },
  };
}

test('with the lobby open but the models still loading, a scan has something to wait for', async () => {
  const h = harness();
  await h.openLobby();

  // This is the whole new risk surface: the lobby is usable and none of the three models enrolment
  // reads has arrived.
  assert.deepEqual(h.startup.pending(), ['poseDetector', 'embedder', 'reid']);
  assert.equal(h.landed.embedder, undefined, 'nothing to enrol with yet');

  let waited = false;
  h.startup.waitForOptional(500).then(() => {
    waited = true;
  });
  await settle();
  assert.equal(waited, false, 'the scan must not start embedding with no embedder');
});

test('the wait ends when the models land, and the embedder is there to enrol with', async () => {
  const h = harness();
  await h.openLobby();

  let waited = false;
  const wait = h.startup.waitForOptional(500).then(() => {
    waited = true;
  });

  h.gates.poseDetector.resolve('pose');
  await settle();
  assert.deepEqual(h.startup.pending(), ['embedder', 'reid'], 'reported one at a time, so the status line is honest');
  assert.equal(waited, false, 'still waiting on the two that decide gallery quality');

  h.gates.embedder.resolve('mobilenet');
  h.gates.reid.resolve('osnet');
  await wait;

  assert.deepEqual(h.startup.pending(), []);
  assert.equal(waited, true);
  // The regression this guards: a scan that went ahead here would have passed `null` into
  // extractSignature and enrolled a gallery with no `embed` vector at all.
  assert.equal(h.landed.embedder, 'mobilenet');
  assert.equal(h.landed.reid, 'osnet');
});

test('a model that failed is not waited for - null is its final answer', async () => {
  const h = harness();
  await h.openLobby();
  h.gates.poseDetector.resolve(null);
  h.gates.embedder.resolve(null);
  h.gates.reid.resolve(null);

  await h.startup.waitForOptional(500);
  assert.deepEqual(h.startup.pending(), [], 'settled, even though every slot is empty');
  assert.deepEqual(h.landed, { poseDetector: null, embedder: null, reid: null });
});

test('a hung download degrades the scan instead of trapping the player on the scan screen', async () => {
  const h = harness();
  await h.openLobby();
  h.gates.poseDetector.resolve('pose');
  h.gates.embedder.resolve('mobilenet');
  // reid never settles: a download that stalled with no error.

  // The timeout is the only thing that can resolve this, since `reid` never will. Reaching the
  // next line at all is the assertion; the scan then goes ahead with the models it does have.
  await h.startup.waitForOptional(20);
  assert.deepEqual(h.startup.pending(), ['reid'], 'and it is still honest about what never arrived');
  assert.equal(h.landed.embedder, 'mobilenet', 'the scan is not degraded further than it has to be');
});

test('once everything has landed there is nothing to wait for at all', async () => {
  const h = harness();
  await h.openLobby();
  h.gates.poseDetector.resolve('pose');
  h.gates.embedder.resolve('mobilenet');
  h.gates.reid.resolve('osnet');
  await h.startup.models.all;

  assert.deepEqual(h.startup.pending(), []);
  // The normal case: the lobby takes a deliberate tap to leave, which these usually outlast, so
  // waiting costs the player nothing and no status line is ever shown. A ten-minute timeout that
  // returns immediately is the assertion - if the timer were what resolved this, or if it were
  // left pending afterwards, the test would hang instead of passing.
  await h.startup.waitForOptional(600_000);
});
