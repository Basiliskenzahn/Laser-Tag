// What the player waits for on the way into the lobby, and what carries on loading behind them.
//
// Entering a room used to take as long as the slowest of 17.1 MB of models, because the join
// screen awaited all of them before it would unhide the lobby. Two separate things were wrong:
//
//   1. The three MediaPipe models were created strictly one after another, so their downloads
//      never overlapped - 7.25 MB, then 5.78 MB, then 4.12 MB.
//   2. The lobby was gated on all three, although detector.js has always said that two of them
//      are optional and that the caller gets null for whichever one the phone could not manage.
//      The lobby itself (screens/lobby.js) touches no model at all: it lists the roster and shows
//      a Scan button per player.
//
// So the gate is camera + object detector, and nothing else. 7.25 MB on the critical path instead
// of 17.1 MB. The pose landmarker, the image embedder and the re-identification model keep loading
// while the player reads the lobby, land in `state` whenever they arrive, and get their warm-up
// frame then rather than at a fixed point (camera.js explains why the warm-up matters). The one
// screen that genuinely needs them - enrolment, which bakes a signature into a cached gallery for
// the rest of the round - waits for the specific models it uses at the point of use instead
// (screens/scan.js).
//
// The ordering constraint that survives is the delegate: the object detector's GPU attempt is
// what decides whether this phone is on 'GPU' or 'CPU', and pose and the embedder are created
// with the same answer so the three can never end up split across both. They are started from a
// single continuation on that answer, so they overlap with each other even though neither can
// start before it.
//
// Not overlapping their *downloads* with the object detector's is deliberate. The obvious trick -
// fetch() the two optional models early so createFromOptions() finds them in the HTTP cache - is
// worse than useless here, because frontend/common-locations.conf serves .tflite and .task with
// `Cache-Control: no-store`: the browser is not allowed to reuse the response, so the prefetch
// would download 9.9 MB that gets downloaded again. Creating them speculatively on 'GPU' before
// the object detector has answered is the other option, and it pays double on exactly the phones
// that fall back to CPU. Neither is worth it now that nothing the player can see is behind them.
//
// This module deliberately has no imports: it touches no DOM, no `state` and no model library, so
// the sequencing above is testable on its own (test/startup-sequencing.test.js). camera.js is
// where it is wired to the real camera and the real models.

// Durations in ms for the debug overlay (?debug), filled in as each step finishes. `camera` and
// `fileset` are measured from the start of startup; the per-model entries are that model's own
// create() call, so they can be compared against each other; `lobby` and `all` are totals.
export const timings = {
  camera: null,
  fileset: null,
  detector: null,
  poseDetector: null,
  embedder: null,
  reid: null,
  lobby: null,
  all: null,
};

// Which optional models are still outstanding, and the order they are reported in.
export const OPTIONAL_MODELS = ['poseDetector', 'embedder', 'reid'];

let startedAt = null;

function resetTimings(now) {
  for (const key of Object.keys(timings)) timings[key] = null;
  startedAt = now;
}

// Starts the camera and every model, and reports back two different kinds of "ready".
//
//   ready  - camera + object detector, which is what the lobby is allowed to wait for. Resolves
//            with { detector, delegate }; rejects only if one of those two failed, because those
//            are the two failures the join screen has a message for.
//   models - a promise per optional model, each resolving to the model or to null, never
//            rejecting, plus `all` for "nothing is still loading".
//
// Every argument is injected so this stays free of the DOM and of the model libraries:
//   startCamera()                      -> Promise, resolved when there is a usable video frame
//   createFileset()                    -> Promise<fileset>, the shared MediaPipe wasm bundle
//   createObjectDetector(fileset)      -> Promise<{ detector, delegate }>
//   createPoseDetector(fileset, deleg) -> Promise<pose|null>
//   createEmbedder(fileset, delegate)  -> Promise<embedder|null>
//   createReid()                       -> Promise<reid|null>, independent of fileset and delegate
//   onModel(name, model)               -> land an optional model wherever the app reads it
//   warmUp(name, model)                -> give a freshly created model its throwaway inference
//   now()                              -> a clock, so tests can supply their own
export function beginStartup({
  startCamera,
  createFileset,
  createObjectDetector,
  createPoseDetector,
  createEmbedder,
  createReid,
  onModel = () => {},
  warmUp = () => {},
  now = () => performance.now(),
}) {
  resetTimings(now());
  const since = (from) => Math.round(now() - from);
  const total = () => since(startedAt);

  const camera = Promise.resolve()
    .then(startCamera)
    .then((value) => {
      timings.camera = total();
      return value;
    });

  const fileset = Promise.resolve()
    .then(createFileset)
    .then((value) => {
      timings.fileset = total();
      return value;
    });

  // The required model. Its delegate answer is what the two optional MediaPipe models are then
  // created with, so they hang off this promise rather than off `fileset`.
  const object = fileset.then(async (bundle) => {
    const at = now();
    const result = await createObjectDetector(bundle);
    timings.detector = since(at);
    return result;
  });

  // Both optional MediaPipe models are started from the same continuation on `object`, so they
  // run concurrently with each other - the delegate is the only thing they had to queue behind.
  // The catch is belt-and-braces: detector.js already returns null rather than throwing, and a
  // model that threw anyway must still not reject the chain the scan path awaits.
  const mediapipeModel = (name, create) =>
    Promise.all([fileset, object]).then(([bundle, { delegate }]) => {
      const at = now();
      return Promise.resolve()
        .then(() => create(bundle, delegate))
        .catch((err) => {
          console.warn(`${name} unavailable`, err);
          return null;
        })
        .then((model) => {
          timings[name] = since(at);
          return model;
        });
    });

  // Re-identification is ONNX Runtime, not the MediaPipe graph: it shares neither the wasm bundle
  // nor the delegate, so it has nothing to wait for and starts immediately.
  const reidModel = Promise.resolve()
    .then(() => {
      const at = now();
      return Promise.resolve()
        .then(createReid)
        .catch((err) => {
          console.warn('Re-identification model unavailable', err);
          return null;
        })
        .then((model) => {
          timings.reid = since(at);
          return model;
        });
    });

  // Landing and warming happen as each model resolves, not at a fixed point, because by then the
  // player may already be in the lobby - and a model that arrives late still has an unpaid first
  // inference to get rid of.
  const settled = new Set();
  const land = (name, promise) =>
    promise.then((model) => {
      settled.add(name);
      onModel(name, model);
      if (model) warmUp(name, model);
      return model;
    });

  const models = {
    poseDetector: land('poseDetector', mediapipeModel('poseDetector', createPoseDetector)),
    embedder: land('embedder', mediapipeModel('embedder', createEmbedder)),
    reid: land('reid', reidModel),
  };

  const ready = Promise.all([camera, object]).then(([, vision]) => vision);

  models.all = Promise.all([
    ready.catch(() => null),
    ...OPTIONAL_MODELS.map((name) => models[name]),
  ]).then(() => {
    timings.all = total();
  });

  return {
    ready,
    models,
    // Which optional models have not settled yet, for the one screen that has to wait for them.
    // A model that failed counts as settled: null is its final answer, and enrolment goes ahead
    // without it rather than waiting for something that is never coming.
    pending: () => OPTIONAL_MODELS.filter((name) => !settled.has(name)),
    // Resolves once nothing is still loading, or once `timeoutMs` has passed - whichever is
    // first. Never rejects. The timeout is the only thing standing between a hung download and a
    // scan screen that cannot be got past except with the ✕, and it is cleared when the models
    // win the race so a rescan does not leave a string of dead timers behind it.
    waitForOptional: (timeoutMs) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        models.all.then(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

// The join screen calls this once the lobby is actually on screen, which is the number the whole
// change is about and the only one this module cannot observe for itself.
export function markLobbyVisible(now = () => performance.now()) {
  if (startedAt != null && timings.lobby == null) timings.lobby = Math.round(now() - startedAt);
}

// One line for the debug overlay, e.g.
//   Startup cam 310ms · wasm 190ms · obj 980ms · pose 760ms · embed 540ms · reid 410ms → lobby 1.3s · all 2.1s
export function startupTimingLine() {
  const ms = (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`);
  const parts = [];
  const add = (label, key) => {
    if (timings[key] != null) parts.push(`${label} ${ms(timings[key])}`);
  };
  add('cam', 'camera');
  add('wasm', 'fileset');
  add('obj', 'detector');
  add('pose', 'poseDetector');
  add('embed', 'embedder');
  add('reid', 'reid');
  if (!parts.length) return '';
  const totals = [];
  if (timings.lobby != null) totals.push(`lobby ${ms(timings.lobby)}`);
  if (timings.all != null) totals.push(`all ${ms(timings.all)}`);
  return `Startup ${parts.join(' · ')}${totals.length ? ` → ${totals.join(' · ')}` : ''}`;
}
