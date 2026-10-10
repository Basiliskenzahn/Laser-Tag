// That the input readout costs nothing without `?debug` (frontend/public/screens/game.js).
//
// test/shot-latency.test.js already proves this behaviourally for everything observable: it fires
// five shots with ?debug absent and the overlay is neither written to nor relocated. What it
// cannot see is the work that would happen before any of that becomes observable - building the
// sample object handed to recordShot(), and reading the clock a second time to fill it in. Those
// leave no trace to assert on, so they are held down structurally instead: every call sits inside
// an `if (DEBUG)` block, and the recorders are no-ops on the null stats a non-debug load holds
// even if one ever escaped.
//
// This is the same argument test/range-readout-cost.test.js makes for the range readout, and the
// brace matcher both use lives in test/helpers/source-blocks.js. The one difference is that the
// input readout has calls in two places - loop() and fire() - so this checks membership of *any*
// if (DEBUG) block rather than one particular one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { debugBlocks, insideAny, occurrences } from './helpers/source-blocks.js';

const SOURCE = readFileSync(new URL('../frontend/public/screens/game.js', import.meta.url), 'utf8');
const READOUT = readFileSync(new URL('../frontend/public/input-latency.js', import.meta.url), 'utf8');
const BLOCKS = debugBlocks(SOURCE);

test('the anchors this test depends on are actually there', () => {
  // Without these the assertions below would pass vacuously on a file that had been rewritten.
  assert.ok(BLOCKS.length >= 2, `expected an if (DEBUG) block in both loop() and fire(), found ${BLOCKS.length}`);
  for (const block of BLOCKS) assert.ok(block.end > block.start + 20, 'an if (DEBUG) block looks implausibly short');
  // The blocks do not overlap and none ran away to the end of the file.
  const sorted = [...BLOCKS].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, 'two DEBUG blocks overlap');
  assert.ok(sorted.at(-1).end <= SOURCE.length);
  // One of them is inside fire(), which is the new one and the easiest to lose in a refactor.
  const fireAt = SOURCE.indexOf('export function fire(');
  const afterFire = SOURCE.indexOf('async function postHit(');
  assert.ok(fireAt > 0 && afterFire > fireAt);
  assert.ok(
    BLOCKS.some((block) => block.start > fireAt && block.end < afterFire),
    'fire() has no if (DEBUG) block, so the shot is being measured unconditionally',
  );
});

// One entry per thing that must not run without ?debug.
const DEBUG_ONLY_CALLS = ['recordShot', 'recordBlock', 'inputLatencyLine'];

for (const name of DEBUG_ONLY_CALLS) {
  test(`${name} is only ever reached from inside an if (DEBUG) block`, () => {
    const at = occurrences(SOURCE, name);
    assert.ok(at.length > 0, `${name} is not referenced at all - the readout is not wired up`);
    // The import statement names it at module scope by necessity; every other mention is a use.
    const importEnd = SOURCE.indexOf("from '../input-latency.js';");
    assert.ok(importEnd > 0, 'the input-latency import was not found');
    // After the import statement (which names it at module scope by necessity) and followed by
    // `(`, so a mention in a comment is not mistaken for a call that has to be guarded.
    const uses = at.filter((i) => i > importEnd && SOURCE[i + name.length] === '(');
    assert.ok(uses.length > 0, `${name} is imported but never called`);
    for (const i of uses) {
      assert.ok(
        insideAny(BLOCKS, i),
        `${name} is used at index ${i}, outside every if (DEBUG) block:\n  ...${SOURCE.slice(Math.max(0, i - 80), i + 80)}...`,
      );
    }
  });
}

test('the samples object is not even allocated without ?debug', () => {
  // `const inputStats = DEBUG ? emptyInputStats() : null` - the only mention of emptyInputStats
  // outside its import, and the reason every recorder can be a no-op rather than a crash.
  assert.match(SOURCE, /const inputStats = DEBUG \? emptyInputStats\(\) : null;/);
  assert.equal(occurrences(SOURCE, 'emptyInputStats').length, 2, 'emptyInputStats is called somewhere else too');
});

test('the readout module holds no per-frame state to pay for', () => {
  // If it kept a buffer or a cache, "nothing runs without ?debug" would stop being the whole
  // story: the allocation would happen at import, on every load, debug or not. The stats object
  // belongs to screens/game.js for exactly this reason.
  // Column zero only: `let` inside a function is a local and costs nothing until it is called.
  assert.doesNotMatch(READOUT, /^let /m, 'module-level mutable state in input-latency.js');
  assert.doesNotMatch(READOUT, /^var /m);
  // And nothing runs at import beyond the declarations themselves.
  assert.doesNotMatch(READOUT, /^[A-Za-z_$][\w$]*\(/m, 'a top-level call in input-latency.js');
});

test('app.js hands the originating event timestamp to fire()', () => {
  // The measurement is only possible because the *event's* timeStamp crosses the boundary: it is
  // when the browser made the tap, so the gap to fire() entry is the queueing delay. A listener
  // that calls `fire()` bare throws that away and the tap figure goes permanently blank - which
  // no runtime test can see, because app.js is pure wiring that only runs in a browser.
  const app = readFileSync(new URL('../frontend/public/app.js', import.meta.url), 'utf8');
  // Sliced to the pointerdown handler rather than matched across the whole file: with `[\s\S]*?`
  // a bare `fire()` here would happily match the *keydown* handler's `fire(event.timeStamp)`
  // further down, and this test passed a mutation that did exactly that.
  const pointerdownAt = app.indexOf("addEventListener('pointerdown'");
  const handlerEnd = app.indexOf('});', pointerdownAt);
  assert.ok(pointerdownAt > 0, 'the fire button has no pointerdown listener');
  assert.ok(handlerEnd > pointerdownAt, 'could not find the end of the pointerdown handler');
  assert.match(app.slice(pointerdownAt, handlerEnd), /fire\(event\.timeStamp\);/);
  // And the tap handler stays on pointerdown: `click` would add a tap delay of its own, which is
  // the thing people reach for first and the thing that is already right here.
  assert.doesNotMatch(app, /'fire-btn'\)\.addEventListener\('click'/);
  // The keyboard path too, so a desktop test of the same thing measures the same way. Bounded to
  // one line for the same reason as above.
  assert.match(app, /event\.code === 'Space'[^\n]*fire\(event\.timeStamp\)/);
});

test('the shot path itself has no detection left on it', () => {
  // The behavioural proof is in test/shot-latency.test.js (the detector is never called); this is
  // the tripwire for someone re-adding the call and not noticing it is on the critical path.
  const fireAt = SOURCE.indexOf('export function fire(');
  const afterFire = SOURCE.indexOf('async function postHit(');
  const body = SOURCE.slice(fireAt, afterFire);
  assert.ok(fireAt > 0 && afterFire > fireAt);
  assert.doesNotMatch(body, /refreshGameDetection\(/, 'fire() forces a detection again');
  assert.doesNotMatch(body, /detectGameplayPeople\(|detectTrackedPeople/, 'fire() runs an inference again');
});
