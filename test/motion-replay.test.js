// The capture-and-replay harness, against the synthetic example recording.
//
// test/motion.test.js tests the matcher's maths. This file tests the thing that lets a *real*
// session be measured: that a recording can be replayed deterministically, that the replay
// rebuilds the client's state the way the live client had it, and that the report's scoring
// against operator-supplied ground truth says what it claims to.
//
// The load-bearing assertion is the faithfulness one: a recording stores the verdict the live
// matcher reached at each instant, and the replay has to reproduce every one of them from the raw
// inputs alone. If someone changes how motion-identity.js buffers boxes, remote samples or ego
// flags without changing tools/motion-replay.js to match, that is where it shows up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { formatReport, observationsAt, parseRecording, remoteAt, replay } from '../tools/motion-replay.js';
import { buildRecording } from '../tools/make-synthetic-recording.js';
import { MotionRecorder } from '../frontend/public/motion/capture.js';

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'motion-session-synthetic.json');
const recording = parseRecording(readFileSync(FIXTURE, 'utf8'));
const REX = recording.players.find((p) => p.name === 'Rex').id;
const KAI = recording.players.find((p) => p.name === 'Kai').id;

test('the committed fixture is labelled synthetic and carries its ground truth', () => {
  assert.equal(recording.synthetic, true, 'a fixture that is not measured data must say so');
  assert.match(recording.note, /synthetic|simulated/i);
  assert.deepEqual(recording.truth, { 1: REX, 2: KAI, 3: 'bystander' });
  assert.equal(recording.tracks.length, 3);
  assert.ok(recording.remote.length > 50, 'should contain the relayed motion messages');
  assert.ok(recording.own.ego.length > 50, 'should contain the shooter\'s panning flags');
  // Every box observation is [t, x, y, w, h] on the Date.now() clock.
  for (const track of recording.tracks) {
    assert.ok(track.observations.length >= 2);
    for (const observation of track.observations) {
      assert.equal(observation.length, 5);
      assert.ok(observation.every(Number.isFinite));
    }
  }
});

test('the fixture generator is deterministic and matches what is committed', () => {
  const a = JSON.stringify(buildRecording());
  assert.equal(a, JSON.stringify(buildRecording()), 'two runs of the generator must agree');
  assert.equal(
    a,
    JSON.stringify(recording),
    'the committed fixture is stale: re-run `node tools/make-synthetic-recording.js`',
  );
});

test('replaying reproduces every verdict the live matcher reached', () => {
  const report = replay(recording);
  assert.ok(report.drift.compared > 300, `only ${report.drift.compared} live verdicts to check`);
  assert.deepEqual(
    report.drift.mismatches,
    [],
    'the replay no longer rebuilds the client state the way motion-identity.js does',
  );
});

test('replaying the same recording twice gives the same report', () => {
  assert.equal(JSON.stringify(replay(recording)), JSON.stringify(replay(recording)));
  assert.equal(formatReport(replay(recording)), formatReport(replay(recording)));
});

test('the report scores each person against the operator\'s ground truth', () => {
  const report = replay(recording);
  const byId = new Map(report.tracks.map((track) => [track.id, track]));

  // Each player's own phone confirms them, and nobody else's does.
  for (const [trackId, playerId] of [[1, REX], [2, KAI]]) {
    const track = byId.get(trackId);
    assert.equal(track.expectsPlayer, true);
    assert.equal(track.selfVerdict, 'consistent', `track ${trackId}: ${JSON.stringify(track.pairs)}`);
    assert.deepEqual(track.falsePositives, [], `track ${trackId} had a false positive`);
    const own = track.pairs.find((pair) => pair.playerId === playerId);
    assert.ok(own.correlation.median > 0.8, `own correlation only ${own.correlation.median}`);
  }

  // The bystander is nobody, so any "consistent" pair would be a false positive.
  const bystander = byId.get(3);
  assert.equal(bystander.truth, 'bystander');
  assert.equal(bystander.expectsPlayer, false);
  assert.equal(bystander.scored, true, 'a bystander label is a label and must be scored');
  assert.deepEqual(bystander.falsePositives, []);

  assert.deepEqual(
    { labelled: 2, identified: 2, vetoed: 0, falsePositives: 0, bystanders: 1, cleanBystanders: 1, unlabelled: 0 },
    {
      labelled: report.totals.labelled,
      identified: report.totals.identified,
      vetoed: report.totals.vetoed,
      falsePositives: report.totals.falsePositives,
      bystanders: report.totals.bystanders,
      cleanBystanders: report.totals.cleanBystanders,
      unlabelled: report.totals.unlabelled,
    },
  );
});

test('fusion is replayed too, including the mis-identification motion corrects', () => {
  const report = replay(recording);
  const reasons = (id) => new Map(report.tracks.find((track) => track.id === id).fusion);
  // The fixture's classifier reads track 2 (Kai) as Rex. Where Rex's phone is clearly
  // inconsistent, fuseMotion retargets to Kai; where it is merely unclear, the wrong
  // classifier identification stands. Both branches have to appear.
  assert.ok(reasons(2).get('corrected') > 0, 'motion never corrected the mis-identified person');
  assert.ok(reasons(2).get('classifier-only') > 0);
  assert.ok(reasons(1).get('confirmed') > 0, 'the correctly identified person was never confirmed');
  assert.ok(reasons(3).get('unrecognised') > 0, 'the bystander should stay unrecognised');
});

test('thresholds can be retuned on a recorded session without re-recording it', () => {
  // An unreachable correlation floor: nothing may be confirmed any more.
  const strict = replay(recording, { consistentAt: 0.999 });
  assert.equal(strict.totals.identified, 0);
  assert.ok(strict.drift.mismatches.length > 0, 'changed thresholds should diverge from the live verdicts');
  // ...but the faithfulness check must still be the faithfulness check, not the retune's own
  // divergence, or every retune would look like a broken harness.
  assert.deepEqual(strict.faithfulness.mismatches, [], 'a retune must not be reported as harness drift');
  assert.equal(strict.faithfulness.compared, replay(recording).drift.compared);

  // A 4 s window is what the matcher's comment says lets bystanders match by coincidence; the
  // point here is only that the option reaches motionCheck and changes the answer.
  const shortWindow = replay(recording, { windowMs: 4000 });
  assert.notEqual(JSON.stringify(shortWindow.tracks), JSON.stringify(replay(recording).tracks));
});

test('the client state is rebuilt as of the instant being replayed, not from the whole file', () => {
  const track = recording.tracks[0];
  const first = track.observations[0][0];
  const last = track.observations[track.observations.length - 1][0];

  assert.equal(observationsAt(track, first - 1).length, 0, 'nothing exists before the first frame');
  assert.equal(observationsAt(track, first).length, 1);
  assert.ok(observationsAt(track, last).length < track.observations.length, '12 s of history, not the whole session');
  // Boxes come back in the { t, box } shape visualActivity() wants.
  const [observation] = observationsAt(track, first);
  assert.deepEqual(Object.keys(observation), ['t', 'box']);
  assert.deepEqual(Object.keys(observation.box), ['x', 'y', 'w', 'h']);

  // Remote series only contain what had actually arrived, which is the whole reason a recording
  // stores arrival times separately from sample timestamps.
  const total = (series) => [...series.values()].reduce((sum, list) => sum + list.length, 0);
  const firstArrival = recording.remote[0].at;
  const lastArrival = recording.remote[recording.remote.length - 1].at;
  assert.equal(remoteAt(recording, firstArrival - 1).size, 0, 'nothing has arrived yet');
  const early = remoteAt(recording, firstArrival);
  assert.ok(early.size >= 1);
  assert.ok(total(early) > 0 && total(early) < total(remoteAt(recording, lastArrival)));
});

// The capture half. MotionRecorder is the part of motion/capture.js with no DOM in it (the
// operator panel and the download are not testable here), so it can be driven exactly the way
// motion-identity.js drives it and the result handed straight to the replay.
test('the recorder emits a file the harness can read back', () => {
  const t0 = 1_700_000_000_000;
  const recorder = new MotionRecorder({ userAgent: 'test', startedAt: t0 });
  recorder.self = { playerId: 'me', name: 'Me' };
  recorder.room = 'unit';
  recorder.seePlayers([{ id: 'me', name: 'Me', alive: true }, { id: 'rex', name: 'Rex', alive: true }], t0);
  recorder.ownActivity([[t0 + 100, 0.2], [t0 + 200, 0.3]]);
  recorder.ownEgo([{ t: t0 + 100, v: 0 }, { t: t0 + 200, v: 1 }]);
  recorder.remoteMotion('rex', [[t0 + 100, 1.4]], t0 + 260);
  for (let i = 0; i < 6; i++) {
    recorder.boxes([{ id: 7, box: { x: 10 + i, y: 20, w: 30, h: 90 } }], t0 + 140 * i);
  }
  recorder.classifier(7, { playerId: 'rex', name: 'Rex', confident: true, candidates: ['rex'] }, t0 + 300);
  // After the last box, as in the live client: recordTrackMotion() runs before resolveIdentity()
  // in the same frame, so a check never precedes the observations it was made from. One remote
  // sample is not enough to correlate, so "unknown" is what the matcher really says here.
  recorder.liveChecks(7, { rex: { status: 'unknown', reason: 'not enough data' } }, t0 + 800);
  recorder.setTruth(7, 'rex');

  const recording = recorder.toJSON();
  assert.equal(recording.synthetic, false, 'a real recording must not claim to be synthetic');
  assert.deepEqual(recording.truth, { 7: 'rex' });
  assert.deepEqual(recording.own.activity, [[t0 + 100, 0.2], [t0 + 200, 0.3]]);
  assert.deepEqual(recording.own.ego, [[t0 + 100, 0], [t0 + 200, 1]]);
  assert.deepEqual(recording.remote, [{ at: t0 + 260, from: 'rex', s: [[t0 + 100, 1.4]] }]);
  assert.equal(recording.tracks[0].observations.length, 6);
  assert.deepEqual(recording.tracks[0].observations[0], [t0, 10, 20, 30, 90]);

  // Repeated identical classifier opinions collapse; a changed one is appended.
  recorder.classifier(7, { playerId: 'rex', name: 'Rex', confident: true, candidates: ['rex'] }, t0 + 500);
  assert.equal(recorder.toJSON().tracks[0].classifier.length, 1);
  recorder.classifier(7, { playerId: 'rex', name: 'Rex', confident: false, candidates: ['rex'] }, t0 + 600);
  assert.equal(recorder.toJSON().tracks[0].classifier.length, 2);

  // And the whole thing survives a round trip through JSON into the harness.
  const report = replay(parseRecording(JSON.stringify(recorder.toJSON())));
  assert.equal(report.tracks.length, 1);
  assert.equal(report.tracks[0].truthName, 'Rex');
  assert.equal(report.tracks[0].expectsPlayer, true);
  assert.deepEqual(report.faithfulness.mismatches, []);
});

test('ego flags are only copied out of the sensor buffer once', () => {
  const recorder = new MotionRecorder({ startedAt: 0 });
  // motion-identity.js hands over the sensor's whole rolling buffer on every frame, so the
  // recorder has to deduplicate or the series would be repeated dozens of times over.
  recorder.ownEgo([{ t: 100, v: 0 }, { t: 200, v: 1 }]);
  recorder.ownEgo([{ t: 100, v: 0 }, { t: 200, v: 1 }, { t: 300, v: 1 }]);
  assert.deepEqual(recorder.toJSON().own.ego, [[100, 0], [200, 1], [300, 1]]);
});

test('a file that is not a recording is rejected rather than silently scored', () => {
  assert.throws(() => parseRecording('{"format":"something-else"}'), /not a motion session recording/);
  assert.throws(() => parseRecording(JSON.stringify({ ...recording, version: 99 })), /unsupported recording version/);
  assert.throws(() => parseRecording(JSON.stringify({ ...recording, tracks: undefined })), /missing "tracks"/);
});
