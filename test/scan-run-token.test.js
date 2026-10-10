// Guards the run-token discipline in frontend/public/screens/scan.js.
//
// The bug this exists for: `state.autoScanning` means "a scan is running", and BOTH cancelScan()
// and beginPlayerScan() clear it. So the flag cannot distinguish a cancelled run from a superseded
// one. A run parked on an await - `whenScanModelsReady()` holds for up to SCAN_MODEL_WAIT_MS - would
// see the flag set back to true by the next scan, pass its own `!state.autoScanning` check, and run
// to completion under whoever was being scanned by then. With saveCurrentScan reading
// `state.scanTargetId` at save time, that sent and cached one player's gallery under another
// player's id, mislabelling them for the whole round; the stale run's `finally` also cleared the
// flag out from under the scan that replaced it, killing that one silently too.
//
// This is a source-level check rather than a behavioural one, and that is a real limitation worth
// stating: `screens/scan.js` cannot be imported under Node, because it reaches `detector.js`, which
// imports '/vendor/tasks-vision/vision_bundle.mjs' - an absolute URL Node will not resolve. Driving
// runAutoScan() for real needs a module-loader harness that does not exist yet. So these assertions
// pin the four properties the fix rests on, each of which would silently regress the bug above if
// edited away. They would NOT catch a new await added without a guard - see the note at the bottom.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SRC = fileURLToPath(new URL('../frontend/public/screens/scan.js', import.meta.url));
const src = readFileSync(SRC, 'utf8');

/** Strip comments, so prose describing a rule cannot satisfy an assertion about the code. */
function code(text) {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of a top-level `function name(...) { ... }`, by brace counting. */
function functionBody(name) {
  const header = new RegExp(`function\\s+${name}\\s*\\(`);
  const start = src.search(header);
  assert.notEqual(start, -1, `no function ${name} in scan.js`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return code(src.slice(open + 1, i));
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const runAutoScan = functionBody('runAutoScan');

test('a scan run takes a token, so it can tell itself apart from the next run', () => {
  assert.match(runAutoScan, /const\s+run\s*=\s*\+\+scanRun\s*;/);
  assert.match(runAutoScan, /run\s*===\s*scanRun/, 'the token is taken but never compared');
});

test('the liveness predicate itself compares the token', () => {
  // Deliberately separate from the test above, which an unrelated `run === scanRun` elsewhere in
  // the function (the finally block has one) is enough to satisfy. The whole fix rests on the
  // predicate used at every resume point checking the token, so assert that definition directly.
  // Found by mutation-testing this file: dropping the token from `live()` left the suite green.
  const live = runAutoScan.match(/const\s+live\s*=\s*\(\)\s*=>([^;]+);/);
  assert.ok(live, 'runAutoScan no longer defines a `live()` predicate');
  assert.match(live[1], /run\s*===\s*scanRun/, '`live()` does not check the run token');
  assert.match(live[1], /state\.autoScanning/, '`live()` no longer checks whether the scan is wanted');
});

test('the target id is captured when the run starts, not read when it saves', () => {
  // This is the single line that turned a superseded run into cross-player gallery corruption.
  assert.match(runAutoScan, /const\s+targetId\s*=\s*state\.scanTargetId\s*;/);
  assert.match(
    runAutoScan,
    /saveCurrentScan\(\s*targetId\s*,/,
    'saveCurrentScan must be handed the id this run began with',
  );
  const saveCurrentScan = functionBody('saveCurrentScan');
  assert.doesNotMatch(
    saveCurrentScan,
    /state\.scanTargetId/,
    'saveCurrentScan reads the live target id again, which is exactly the bug',
  );
});

test('no post-await liveness check in runAutoScan relies on state.autoScanning alone', () => {
  // `!state.autoScanning` is the check that a *newer* scan silently satisfies. Every guard that
  // decides whether to keep going must go through the token instead.
  const bare = [...runAutoScan.matchAll(/if\s*\(\s*!state\.autoScanning\b[^)]*\)\s*return/g)];
  assert.deepEqual(
    bare.map((m) => m[0]),
    [],
    'a guard still returns on !state.autoScanning without checking the run token',
  );
});

test('a superseded run does not clear the shared flags or the screen on its way out', () => {
  // Without this the stale run's `finally` cancels the scan that replaced it.
  const guarded = /if\s*\(\s*run\s*===\s*scanRun\s*\)\s*\{[\s\S]*?state\.autoScanning\s*=\s*false/;
  assert.match(runAutoScan, guarded, 'the finally block resets shared state unconditionally');
});

test('cancelling retires the token, so a parked run dies with no rescan needed', () => {
  assert.match(functionBody('cancelScan'), /scanRun\s*\+\+/);
});

test('every await in runAutoScan is followed by a liveness check', () => {
  // The weakest of these assertions, and the one most likely to go stale: it counts awaits rather
  // than understanding them. A new await added without a `live()` after it is the realistic way to
  // reintroduce this bug, and this is a blunt instrument against that. If it fires spuriously,
  // prefer adding the guard over loosening the test.
  const awaits = (runAutoScan.match(/\bawait\b/g) ?? []).length;
  const checks = (runAutoScan.match(/\blive\(\)/g) ?? []).length;
  assert.ok(awaits > 0, 'runAutoScan has no awaits - this test is checking the wrong function');
  assert.ok(
    checks >= 4,
    `runAutoScan has ${awaits} awaits but only ${checks} live() checks; every resume point needs one`,
  );
});
