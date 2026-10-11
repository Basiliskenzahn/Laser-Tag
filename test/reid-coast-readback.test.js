// What a cycle the detector came back empty-handed from costs in re-identification
// (frontend/public/identify.js, `Tracker.update`).
//
// `reid.request()` is the one call in the identification path that spends main-thread time on the
// spot: a getImageData(128, 256) GPU->CPU readback, synchronous, before the embedding itself is
// handed to the worker. Two things in `Tracker.update` decide whether a cycle pays it, and before
// this file neither was pinned for a track the detector *missed*:
//
//   - the identification loop opens with `if (track.lastSeen !== now) continue`, so a track that
//     was not matched to a box this cycle is not checked at all; and
//   - the request itself is additionally gated on `(track.missedFrames ?? 0) === 0`.
//
// test/range-reid-gate.test.js already covers the other arm of that gate (a box under the far
// floor costs no inference) but only ever drives one cycle, so nothing here was reachable from it.
//
// One thing this file deliberately does NOT claim: that the `missedFrames` clause is load-bearing.
// It is not, and no behavioural test can make it so. The loop's `lastSeen !== now` skip already
// excludes every track the detector missed, and the only two writers of `lastSeen = now` -
// `updateTrackBox` and the new-track push - both set `missedFrames = 0` in the same breath. So the
// clause is false only on a cycle the loop has already skipped, and deleting it leaves every test
// here green. That is the right answer, not a hole: the clause buys depth rather than behaviour.
// Where that depth would start to matter is visible in the mutation direction the last two tests
// do catch - take `updateTrackBox`'s reset away and the clause latches requests off for good on
// any track that ever coasted.
//
// Every interval below is a literal taken from the operating point, not from the constant it
// exercises: 100 ms is the settled detection interval (screens/game.js
// DETECT_INTERVAL_SETTLED_MS), 400 ms is comfortably more than one embedding interval, and the
// coast/recover schedule keeps each track inside the 900 ms track timeout. REID_REQUEST_MS is not
// imported - a test that compares the throttle against its own constant asserts x >= x.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bands, frame, installCanvasStub } from './fixtures/synthetic-frame.mjs';

installCanvasStub();

const { Tracker, averageSignatures, extractSignature } = await import('../frontend/public/identify.js');

const VIDEO = { width: 1280, height: 720 };
const PAINT = bands({ head: [196, 158, 130], shirt: [210, 60, 55], accent: [240, 196, 70], trousers: [40, 50, 120] });

// 120x300 of a 720 px frame: 0.417 of frame height, well clear of every range gate, so the only
// thing that can suppress a request in these tests is the coasting/throttle logic under test.
const person = (x, y = 100) => ({ x, y, w: 120, h: 300, score: 0.9 });
const sceneFor = (boxes) => frame(boxes.map((box) => ({ box, paint: PAINT })), VIDEO);

// A random unit vector, and one at a chosen cosine similarity to it. Seeds are passed in rather
// than drawn from a module-level counter, so adding a test here cannot re-roll another one's
// vectors.
function unit(n, seed) {
  let state = seed >>> 0 || 1;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32) || 1e-12;
  const v = Array.from({ length: n }, () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function similarTo(base, cosine, seed) {
  const other = unit(base.length, seed);
  const dot = other.reduce((s, v, i) => s + v * base[i], 0);
  const orth = other.map((v, i) => v - dot * base[i]);
  const norm = Math.hypot(...orth);
  return base.map((v, i) => cosine * v + Math.sqrt(1 - cosine ** 2) * (orth[i] / norm));
}

const REX_REID = unit(512, 10);
const STRONG = similarTo(REX_REID, 0.95, 801); // what the worker keeps handing back for every track

// One enrolled player carrying a re-identification embedding, so `roomScoresOnReid` is true and
// `Tracker.update` takes the production closed-set path: embeddings decide, colours are skipped.
function rexGallery() {
  const entry = averageSignatures([extractSignature(sceneFor([person(100)]), person(100))]);
  entry.reid = REX_REID;
  return [{ id: 'rex', name: 'Rex', gallery: [entry] }];
}

// A tracker plus a stand-in for reid.js that records both halves of the decision:
//   `checks`   - every track that reached the request decision (`reid.latest` is read one line
//                above it, unconditionally), with the missedFrames it arrived with;
//   `requests` - every readback actually spent.
// The two apart are what separates "suppressed" from "never even looked at".
function harness(players = rexGallery()) {
  const tracker = new Tracker();
  const checks = [];
  const requests = [];
  const reid = {
    latest: (track) => {
      checks.push({ id: track.id, missedFrames: track.missedFrames ?? 0 });
      return STRONG;
    },
    request: (track, source, box) => {
      requests.push({ id: track.id, missedFrames: track.missedFrames ?? 0, box, source });
    },
  };
  const step = (boxes, now) =>
    tracker.update(boxes, sceneFor(boxes), players, 'self', now, { reid, closedSet: true });
  return { tracker, checks, requests, step };
}

test('a track the detector missed this cycle spends no re-identification readback', () => {
  const { tracker, checks, requests, step } = harness();

  step([person(400)], 1000);
  assert.equal(requests.length, 1, 'the first sighting has to ask for an embedding, or there is nothing to suppress');
  // Snapshot the due-ness *before* the cycle under test: reading it afterwards would be reading
  // the field the cycle itself may have written, which is no precondition at all.
  const { id, lastReidRequestAt } = tracker.tracks[0];
  assert.ok(1400 - lastReidRequestAt >= 400, 'an embedding is due at 1400, so the throttle cannot be the reason');

  // 400 ms later the detector finds nobody. The track coasts: still alive, well inside the 900 ms
  // timeout, and overdue for a fresh embedding.
  step([], 1400);

  assert.equal(requests.length, 1, 'no readback may be spent on a cycle with no box to read');
  assert.equal(checks.length, 1, 'and a coasting track is not even checked');

  assert.equal(tracker.tracks.length, 1, 'the track must still be alive, or there was no coasting track to test');
  const track = tracker.tracks[0];
  assert.equal(track.id, id, 'and it must be the same track');
  assert.equal(track.missedFrames, 1, 'the setup is a track the detector missed exactly once');
  assert.equal(track.lastSeen, 1000, 'its last real sighting is the previous cycle');
});

test('the same tracker at the same timing does spend one when the person is found', () => {
  // The control. Without it the test above passes just as well if requests have stopped happening
  // at all - which is the failure mode that would hide a real regression.
  const { tracker, checks, requests, step } = harness();

  step([person(400)], 1000);
  assert.equal(requests.length, 1);

  step([person(412)], 1400); // 12 px on: the same person, so the same track

  assert.equal(tracker.tracks.length, 1, 'one person, one track');
  const track = tracker.tracks[0];
  assert.equal(track.missedFrames, 0, 'this cycle the detector did find them');
  assert.equal(track.lastSeen, 1400);

  assert.equal(requests.length, 2, 'a seen track that is due must ask for an embedding');
  assert.equal(checks.length, 2);
  assert.equal(requests[1].id, track.id);
  assert.equal(requests[1].missedFrames, 0);

  // And it is handed the track's own box - the smoothed last *observation*, which is the only box
  // `track.box` is ever set from (updateTrackBox/blendBox). Nothing on this path hands
  // `reid.request` a velocity projection; `predictedBox` is association-only and screens/game.js's
  // `liveBox` is for drawing and aim.
  assert.equal(requests[1].box, track.box, 'the crop is the track box, by reference');
  assert.equal(requests[1].source.videoWidth, 1280, 'and the frame is the one update() was given');
  assert.ok(requests[1].box.x > 400 && requests[1].box.x < 412, 'which is the smoothed observation, between the two sightings');
});

test('suppression lasts exactly as long as the coasting does', () => {
  // The guard must not latch. A track that coasts for one cycle and is then found again is an
  // ordinary seen track, and has to go back to asking for embeddings immediately - otherwise a
  // player who is briefly dropped by the detector stops contributing to their own 3 s median and
  // slowly loses their name.
  const { tracker, checks, requests, step } = harness();

  step([person(400)], 1000);
  const id = tracker.tracks[0].id;
  assert.equal(requests.length, 1);

  step([], 1400); // missed
  assert.equal(requests.length, 1, 'still suppressed while coasting');

  step([person(424)], 1800); // found again, 800 ms after the last real sighting - inside the timeout

  assert.equal(requests.length, 2, 'requests resume on the cycle the track is found again');
  assert.equal(tracker.tracks.length, 1, 'the person must have been picked up by the same track');
  const track = tracker.tracks[0];
  assert.equal(track.id, id, 'a replacement track would make this test vacuous');
  assert.equal(track.missedFrames, 0, 'being found again clears the miss count');
  assert.equal(requests[1].missedFrames, 0);
  assert.deepEqual(checks.map((c) => c.missedFrames), [0, 0], 'and the coast cycle contributed no check');
});

test('a track is only ever checked on a cycle it was seen, however the detector drops it', () => {
  // The property the two gates add up to, swept rather than staged: two people, each dropped by
  // the detector on its own schedule, over cycles at the settled 100 ms interval. Nothing may
  // reach the request decision - let alone spend a readback - on a cycle it has no box for.
  //
  // It is also the assertion that would notice the clause turning into a latch. Every one of
  // these arrivals reads `missedFrames === 0` because `updateTrackBox` clears it on being found
  // again; stop it clearing and the sweep reports the miss counts the clause would then be
  // suppressing on.
  const { checks, requests, step } = harness();

  // `true` = the detector found them this cycle. Runs of misses of one, two and three cycles, on
  // both people, overlapping and not.
  const left = [true, true, false, true, false, false, true, true, true, false, true, true, false, false, false, true];
  const right = [true, false, true, true, true, false, false, true, false, true, true, false, true, true, true, true];

  let x = 300;
  let y = 700;
  for (let cycle = 0; cycle < left.length; cycle++) {
    const boxes = [];
    if (left[cycle]) boxes.push(person((x += 8)));
    if (right[cycle]) boxes.push(person((y -= 8), 110));
    step(boxes, 1000 + cycle * 100);
  }

  assert.ok(checks.length > 0, 'the sweep has to have checked something');
  assert.ok(requests.length > 0, 'and spent some readbacks, or it proves nothing');
  assert.deepEqual(
    [...new Set(checks.map((c) => c.missedFrames))],
    [0],
    'every arrival at the request decision is a track that was seen this cycle',
  );
  assert.deepEqual(
    [...new Set(requests.map((r) => r.missedFrames))],
    [0],
    'and so is every readback that was paid for',
  );
});

test('consecutive cycles at the settled cadence do not each pay a readback', () => {
  // The throttle in the same condition, which was also unpinned: identification runs at RECHECK_MS
  // and embeddings at their own, coarser interval, which is the whole reason the readback does not
  // ride the identification rate. Four cycles at the settled 100 ms detection interval - the real
  // operating point - must not be four readbacks.
  const { checks, requests, step } = harness();

  for (let cycle = 0; cycle < 4; cycle++) step([person(400 + cycle * 6)], 1000 + cycle * 100);

  assert.equal(checks.length, 4, 'every one of those cycles is a real identification check');
  assert.equal(requests.length, 2, 'but the embedding interval is coarser than the check interval');
  assert.deepEqual(requests.map((r) => r.id), [1, 1], 'both belong to the one track');
});
