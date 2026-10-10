// That the range readout costs nothing without `?debug` (frontend/public/screens/game.js).
//
// This is a structural test over the source, and it is worth being clear about why, and about
// what it does and does not prove.
//
// It cannot be a runtime test. screens/game.js reaches detector.js, which imports
// `/vendor/tasks-vision/vision_bundle.mjs` - an absolute browser URL Node cannot resolve - and
// env.js touches `document` at module scope. Importing it here would mean a module-resolution
// hook plus stubs for the camera, the transport and the audio context, i.e. a large and
// rot-prone fake of two modules other branches are actively changing. That is a worse test, not
// a stronger one.
//
// What this DOES prove: every identifier the readout needs is referenced from inside the
// `if (DEBUG) { ... }` block of loop() and nowhere else, so with ?debug absent the branch is not
// taken and none of the string building, array allocation or formatting happens. The readout's
// own cost when it IS taken is not this test's business - see range-readout.test.js.
//
// What it does NOT prove: that identify.js's rangeDiagnostics() counters are themselves free.
// They are integer increments on a path that already runs, which is the agreed cost, but they
// live in another module and are that module's test to write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../frontend/public/screens/game.js', import.meta.url), 'utf8');

// The index just past the `{...}` block whose `{` is at `open`. Comments and string, template and
// regular-expression-free literal contents are skipped, and `${}` placeholders inside templates
// are followed back into code, so a brace in a comment or a string cannot throw the count off.
function blockEnd(src, open) {
  assert.equal(src[open], '{', 'blockEnd must be given the index of a `{`');
  const modes = ['code']; // 'code' | '`' | "'" | '"'
  const savedDepths = []; // one per `${}` placeholder we are currently inside
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const mode = modes[modes.length - 1];
    const c = src[i];
    if (mode === 'code') {
      if (c === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i);
        if (nl < 0) break;
        i = nl;
      } else if (c === '/' && src[i + 1] === '*') {
        const close = src.indexOf('*/', i + 2);
        assert.ok(close > 0, 'unterminated block comment');
        i = close + 1;
      } else if (c === "'" || c === '"' || c === '`') {
        modes.push(c);
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        // depth 0 at the outermost code level is the `}` that closes the block we were given.
        if (depth === 0 && modes.length === 1) return i + 1;
        if (depth < 0) {
          // The `}` that closes a `${}` placeholder: back out to the template that opened it.
          assert.equal(modes.pop(), 'code');
          assert.equal(modes[modes.length - 1], '`', 'unbalanced brace outside a template');
          depth = savedDepths.pop();
        }
      }
    } else if (mode === '`') {
      if (c === '\\') i++;
      else if (c === '`') modes.pop();
      else if (c === '$' && src[i + 1] === '{') {
        savedDepths.push(depth);
        modes.push('code'); // the template marker stays underneath, to come back to
        depth = 0;
        i++;
      }
    } else if (c === '\\') {
      i++;
    } else if (c === mode) {
      modes.pop();
    }
  }
  throw new Error('unbalanced braces: no end found for the block');
}

// Every index at which `needle` appears as a whole identifier.
function occurrences(src, needle) {
  const at = [];
  const pattern = new RegExp(`\\b${needle}\\b`, 'g');
  for (const m of src.matchAll(pattern)) at.push(m.index);
  return at;
}

const loopAt = SOURCE.indexOf('export function loop()');
const debugIfAt = SOURCE.indexOf('if (DEBUG) {', loopAt);
const debugBlockAt = SOURCE.indexOf('{', debugIfAt);
const debugBlockEnd = blockEnd(SOURCE, debugBlockAt);
const inDebugBlock = (at) => at > debugBlockAt && at < debugBlockEnd;

test('the anchors this test depends on are actually there', () => {
  // Without these the assertions below would pass vacuously on a file that had been rewritten.
  assert.ok(loopAt > 0, 'loop() not found');
  assert.ok(debugIfAt > loopAt, '`if (DEBUG) {` not found inside loop()');
  assert.ok(debugBlockEnd > debugBlockAt + 100, 'the DEBUG block looks implausibly short');
  assert.ok(debugBlockEnd <= SOURCE.length);
  // The block ends before anything that follows loop(), i.e. the brace matching did not run away.
  const afterLoop = SOURCE.indexOf('function fitCanvas()');
  assert.ok(afterLoop > 0 && debugBlockEnd < afterLoop, 'the DEBUG block swallowed the rest of the file');
});

// One entry per thing that must not run without ?debug: the readout call, the diagnostics read
// and reset, and the overlay lookup that relocates the element.
const DEBUG_ONLY_CALLS = ['rangeReadoutLine', 'rangeDiagnostics', 'resetRangeDiagnostics', 'debugOverlay'];

for (const name of DEBUG_ONLY_CALLS) {
  test(`${name} is only ever reached from inside the DEBUG block`, () => {
    const at = occurrences(SOURCE, name);
    assert.ok(at.length > 0, `${name} is not referenced at all - the readout is not wired up`);
    // A helper's own `function name(` declaration is at module scope by necessity; every other
    // mention has to be a use, and every use has to be behind the branch.
    const uses = at.filter((i) => !SOURCE.startsWith(`function ${name}(`, i - 'function '.length));
    assert.ok(uses.length > 0, `${name} is declared but never used`);
    for (const i of uses) {
      assert.ok(
        inDebugBlock(i),
        `${name} is used at index ${i}, outside the if (DEBUG) block (${debugBlockAt}..${debugBlockEnd}):\n` +
          `  ...${SOURCE.slice(Math.max(0, i - 60), i + 60)}...`,
      );
    }
  });
}

test('the range diagnostics are read through the namespace, not as named imports', () => {
  // A named import of an export identify.js does not have yet is a link error, and a link error
  // in this module stops the entire app loading - not just the overlay. The sibling branch adding
  // rangeDiagnostics() has not merged, so this must stay a namespace read until it has.
  assert.match(SOURCE, /import \* as matcher from '\.\.\/identify\.js'/);
  assert.doesNotMatch(SOURCE, /import \{[^}]*rangeDiagnostics/s);
  assert.match(SOURCE, /matcher\.rangeDiagnostics\?\.\(\)/);
  assert.match(SOURCE, /matcher\.resetRangeDiagnostics\?\.\(\)/);
});

test('the readout module itself holds no per-frame state to pay for', () => {
  // If it kept a buffer or a cache, "nothing runs without ?debug" would stop being the whole
  // story: the allocation would happen at import, on every load, debug or not.
  const readout = readFileSync(new URL('../frontend/public/range-readout.js', import.meta.url), 'utf8');
  // Column zero only: `let` inside a function is a local and costs nothing until it is called.
  assert.doesNotMatch(readout, /^let /m, 'module-level mutable state in range-readout.js');
  assert.doesNotMatch(readout, /^var /m);
  // And nothing runs at import beyond the declarations themselves.
  assert.doesNotMatch(readout, /^[A-Za-z_$][\w$]*\(/m, 'a top-level call in range-readout.js');
});
