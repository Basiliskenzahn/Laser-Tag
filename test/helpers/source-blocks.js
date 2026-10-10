// Finding `if (DEBUG) { ... }` blocks in front-end source, for the tests that prove a debug-only
// feature costs nothing when `?debug` is absent.
//
// These are structural assertions over text, and it is worth being clear about what they do and
// do not prove. What they DO prove: every identifier a debug-only feature needs is referenced
// from inside an `if (DEBUG)` block and nowhere else, so with ?debug absent the branch is not
// taken and none of the string building, object allocation or formatting happens. What they do
// NOT prove is anything about what happens when the branch *is* taken - that is the feature's own
// unit tests - nor anything about counters kept in other modules.
//
// Extracted from test/range-readout-cost.test.js, which was the first of these, so a second
// feature does not need a second copy of the brace matcher.
import assert from 'node:assert/strict';

// The index just past the `{...}` block whose `{` is at `open`. Comments and string, template and
// regular-expression-free literal contents are skipped, and `${}` placeholders inside templates
// are followed back into code, so a brace in a comment or a string cannot throw the count off.
export function blockEnd(src, open) {
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
export function occurrences(src, needle) {
  const at = [];
  const pattern = new RegExp(`\\b${needle}\\b`, 'g');
  for (const m of src.matchAll(pattern)) at.push(m.index);
  return at;
}

// Every `if (DEBUG) { ... }` block in the source, as `{ start, end }` index pairs. Braces are
// required: a single-statement `if (DEBUG) foo();` would not be found, which is deliberate -
// a test that silently accepted a form it cannot verify would be worse than one that says the
// block is missing.
export function debugBlocks(src) {
  const blocks = [];
  for (const match of src.matchAll(/\bif \(DEBUG\) \{/g)) {
    const start = src.indexOf('{', match.index);
    blocks.push({ start, end: blockEnd(src, start) });
  }
  return blocks;
}

// Is this index inside any of them?
export function insideAny(blocks, at) {
  return blocks.some((block) => at > block.start && at < block.end);
}
