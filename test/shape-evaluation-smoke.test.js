// That the evaluation harness still runs (tools/shape-evaluation.mjs).
//
// The harness is deliberately NOT in `npm test`: it is an instrument, not a regression gate, and
// turning its numbers into assertions would make every legitimate tuning change look like a
// regression. But that left it with no test at all, so it could rot - a renamed export, a changed
// signature, a thrown error in one branch - and nobody would notice until someone ran it and got
// an authoritative-looking table out of a broken instrument. Or no table, after an hour of
// debugging.
//
// So this asserts SHAPE, never VALUES. It checks that the harness runs both of its modes to
// completion, emits well-formed JSON, and that the fields the docs quote exist and are plausible
// numbers. Every bound here is a structural invariant - a rate is between 0 and 1, a count is
// positive - and not a measurement. If you find yourself wanting to pin a number down, that
// belongs in docs/ with a seed next to it, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const HARNESS = new URL('../tools/shape-evaluation.mjs', import.meta.url).pathname;
const SEED = '20251010';
// A full run is 60 sightings per person per bucket and takes a couple of seconds per mode; this
// suite is 0.6 s all in, and a smoke test has no business tripling that. `--sightings` shrinks
// only the population - every threshold, bucket boundary and code path is the real one, which is
// all this test looks at. Numbers quoted in docs/ come from full runs.
const SMALL = ['--sightings', '3'];

function runUncached(args) {
  return execFileSync(process.execPath, [HARNESS, ...args], { encoding: 'utf8', timeout: 120000 });
}

// Memoised, because several tests want the same run and each one is a process spawn. NEVER use
// this to compare two runs of the same arguments - you would be comparing a cached string with
// itself, which is the vacuous assertion this file is trying not to contain. See the determinism
// test, which calls runUncached twice on purpose.
const cache = new Map();
function run(args) {
  const key = args.join(' ');
  if (!cache.has(key)) cache.set(key, runUncached(args));
  return cache.get(key);
}

const isRate = (v, what) => {
  assert.equal(typeof v, 'number', `${what} is not a number`);
  assert.ok(Number.isFinite(v), `${what} is not finite`);
  assert.ok(v >= 0 && v <= 1, `${what} is ${v}, not a rate`);
};

test('the harness runs and returns a well-formed result', () => {
  const result = JSON.parse(run(['--seed', SEED, ...SMALL, '--json']));
  assert.equal(result.seed, 20251010);
  for (const variant of ['fixed', 'legacy']) {
    const r = result[variant];
    assert.ok(r, `no ${variant} report`);
    assert.ok(r.playerSightings > 0, `${variant} scored no player sightings`);
    assert.ok(r.correctPairs > 0, `${variant} scored no correct pairs`);
    for (const field of ['correctAcceptance', 'wrongPlayerAcceptance', 'unresolved', 'bystanderAcceptance']) {
      isRate(r[field], `${variant}.${field}`);
    }
    // Every player sighting ends in exactly one of three outcomes, so these must sum to 1. A
    // structural invariant of the tally, not a measurement of anything.
    const total = r.correctAcceptance + r.wrongPlayerAcceptance + r.unresolved;
    assert.ok(Math.abs(total - 1) < 1e-9, `${variant} outcomes sum to ${total}, not 1`);
    assert.ok(r.gateSweep.length > 0, `${variant} produced no gate sweep`);
  }
});

test('the harness runs its box-scale sweep and returns a well-formed result', () => {
  const sweep = JSON.parse(run(['--seed', SEED, ...SMALL, '--scale-sweep', '--json']));
  assert.equal(sweep.seed, 20251010);
  assert.ok(sweep.rows.length > 0, 'no sweep rows');
  // Buckets must straddle the gate in both directions, or the sweep is not answering its
  // question: the whole point is to show what the threshold is buying on either side of itself.
  assert.ok(
    sweep.rows.some((r) => r.hi <= sweep.gate),
    'no bucket entirely below the height gate',
  );
  assert.ok(
    sweep.rows.some((r) => r.lo >= sweep.gate),
    'no bucket entirely above the height gate',
  );
  assert.ok(
    sweep.rows.some((r) => r.hi <= sweep.farFloor),
    'no bucket entirely below the assumed far floor',
  );
  // Both fixture modes have to be present: the gap between them is the harness's own estimate of
  // how much its optimism is worth, so a sweep that silently ran only one is useless.
  assert.deepEqual([...new Set(sweep.rows.map((r) => r.mode))].sort(), ['ideal', 'sensor']);

  for (const row of sweep.rows) {
    const where = `${row.lo}-${row.hi} ${row.mode}`;
    assert.ok(row.playerSightings > 0, `${where} scored no player sightings`);
    for (const field of [
      'correctAcceptance',
      'wrongPlayerAcceptance',
      'bystanderAcceptance',
      'unresolved',
      'gateRefusedPlayer',
      'gateRefusedBystander',
    ]) {
      isRate(row[field], `${where}.${field}`);
    }
    const total = row.correctAcceptance + row.wrongPlayerAcceptance + row.unresolved;
    assert.ok(Math.abs(total - 1) < 1e-9, `${where} outcomes sum to ${total}, not 1`);
    assert.ok(row.correctScore.n > 0, `${where} recorded no correct-pair scores`);
    assert.ok(row.mismatchScore.n > 0, `${where} recorded no wrong-pair scores`);
    assert.ok(row.medianBoxH > 0 && row.medianBoxW > 0, `${where} has no box size`);
  }
});

test('the harness reports where each threshold it quotes came from', () => {
  // The constants used to be copied into the harness by value, which is how an instrument ends up
  // measuring against a number nothing uses. They are read off identify.js now, and the run says
  // for each one whether it was imported or is standing on a stub - so a missing export is
  // visible in the output instead of being silently papered over. This asserts the *provenance
  // line exists and names every threshold*, not which branch it took: pre-merge they are all
  // stubs, post-merge they are all imports, and both are correct states for this test.
  const sweep = JSON.parse(run(['--seed', SEED, ...SMALL, '--scale-sweep', '--json']));
  assert.ok(Array.isArray(sweep.provenance) && sweep.provenance.length >= 4);
  for (const name of ['MIN_SHAPE_SCORE', 'EVIDENCE_MIN_PART', 'EVIDENCE_MIN_SCORE', 'MIN_MATCH_HEIGHT_RATIO']) {
    const entry = sweep.provenance.find((p) => p.startsWith(`${name}=`));
    assert.ok(entry, `${name} has no provenance entry`);
    assert.match(entry, /\((identify\.js|STUB: identify\.js does not export it)\)$/, `${name}: ${entry}`);
  }
});

test('both modes print a human-readable report, with the caveats attached', () => {
  // The caveats are the difference between a measurement and a number that looks like one, so
  // they are part of the output contract, not decoration.
  const report = run(['--seed', SEED, ...SMALL]);
  assert.match(report, /shape normalisation - synthetic evaluation/);
  assert.match(report, /SYNTHETIC|Synthetic/);

  const sweep = run(['--seed', SEED, ...SMALL, '--scale-sweep']);
  assert.match(sweep, /box-scale sweep/);
  assert.match(sweep, /SYNTHETIC/);
  assert.match(sweep, /cannot tell you/);
  // The two columns the whole sweep exists to report.
  assert.match(sweep, /wrong player/);
  assert.match(sweep, /bystander/);
});

test('the harness is deterministic, and a different seed is a different population', () => {
  // Determinism is what makes "the numbers in docs/ are reproducible" a true claim, so this has
  // to be two actual runs - not the memo handing back the same string twice.
  const args = ['--seed', SEED, ...SMALL, '--scale-sweep', '--json'];
  assert.equal(runUncached(args), runUncached(args));
  assert.notEqual(run(['--seed', '7', ...SMALL, '--scale-sweep', '--json']), run(args));
});
