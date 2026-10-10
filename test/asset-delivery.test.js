// Guards the static asset delivery policy in frontend/common-locations.conf.
//
// This is a text check on the shipped config, deliberately not a Docker or HTTP test:
// `npm test` has to keep working on a laptop with no daemon running, and CI does not run
// tests at all right now. So this cannot prove nginx accepts the file - that is done by
// hand with `nginx -t` (see docs/operations/docker.md) - but it does pin the decisions that
// would otherwise be silently undone by a well-meaning edit, which is the realistic risk:
// the models were on `no-store` for months precisely because the rule looked deliberate.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CONF = fileURLToPath(new URL('../frontend/common-locations.conf', import.meta.url));
const conf = readFileSync(CONF, 'utf8');

/** Strip comments so a directive mentioned in prose can't satisfy an assertion. */
function stripComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, '').replace(/#.*$/gm, '');
}

/**
 * Pull out one `location <match> { ... }` body by brace counting. Brace counting rather
 * than a regex because these blocks nest (the vendor block holds a `types { ... }`).
 */
function locationBody(match) {
  const header = new RegExp(`location\\s+${match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  const start = conf.search(header);
  assert.notEqual(start, -1, `no "location ${match}" block in common-locations.conf`);
  const open = conf.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < conf.length; i += 1) {
    if (conf[i] === '{') depth += 1;
    else if (conf[i] === '}') {
      depth -= 1;
      if (depth === 0) return stripComments(conf.slice(open + 1, i));
    }
  }
  throw new Error(`unbalanced braces in "location ${match}"`);
}

const serverScope = stripComments(conf.slice(0, conf.search(/location\s/)));

test('the models are cacheable: no no-store, and a real max-age', () => {
  const models = locationBody('^~ /models/');
  assert.doesNotMatch(models, /no-store/, 'the 18 MB of models must not be on no-store');
  const maxAge = models.match(/max-age=(\d+)/);
  assert.ok(maxAge, '/models/ needs an explicit max-age');
  assert.ok(Number(maxAge[1]) > 0, '/models/ max-age must be greater than zero');
  assert.match(models, /etag\s+on/, 'ETags are what make the revalidation a 304 instead of a 200');
});

test('the models beat the extension regexes, or they fall back to no-store', () => {
  // nginx tries regex locations before prefix ones, so without "^~" the \.tflite$ and
  // \.task$ blocks below would win and undo the caching above. This is the subtle one.
  assert.match(conf, /location\s+\^~\s+\/models\//, '/models/ must use the ^~ modifier');
  assert.match(conf, /location\s+\^~\s+\/vendor\//, '/vendor/ must use the ^~ modifier');
});

test('the pinned vendor bundle is cacheable and keeps its MIME types', () => {
  const vendor = locationBody('^~ /vendor/');
  assert.doesNotMatch(vendor, /no-store/);
  assert.ok(Number(vendor.match(/max-age=(\d+)/)?.[1]) > 0, '/vendor/ needs a real max-age');
  // A types block inside a location replaces the inherited map, so these must be restated
  // or the browser refuses the module script and the WASM.
  assert.match(vendor, /text\/javascript[^;]*\bmjs\b/, '.mjs must stay text/javascript');
  assert.match(vendor, /application\/wasm[^;]*\bwasm\b/, '.wasm must stay application/wasm');
});

test('the app shell stays uncacheable so a redeploy takes effect at once', () => {
  // Deploys are `git pull && docker compose up --build -d` with no filename hashing, so a
  // cached shell leaves phones on yesterday's client. These are small; caching them buys
  // almost nothing and risks a lot.
  const root = locationBody('/');
  assert.match(root, /no-store/, 'the catch-all must stay no-store');

  // Caching by extension would have caught the app's own modules too. The app/vendor split
  // is by path for exactly that reason, and these blocks must stay no-store to prove it.
  for (const ext of ['mjs', 'wasm']) {
    assert.match(locationBody(`~* \\.${ext}$`), /no-store/,
      `*.${ext} outside /vendor/ is app code and must not be cached`);
  }
});

test('compression is on, and never applied to the models', () => {
  assert.match(serverScope, /^\s*gzip\s+on\s*;/m, 'gzip must be enabled');
  const types = serverScope.match(/gzip_types([^;]*);/);
  assert.ok(types, 'gzip_types must be set explicitly');
  // .tflite/.task/.onnx are all served as application/octet-stream and compress 7.6-12.7%
  // for 115-179 ms of CPU each. Listing this type would spend that for nothing.
  assert.doesNotMatch(types[1], /application\/octet-stream/,
    'octet-stream would compress the models, which measurably does not pay');
  assert.match(types[1], /application\/wasm/,
    'the WASM runtimes are the big win - about 70% off 11-14 MB');
});

test('the realtime paths are never compressed or buffered', () => {
  // Breaking either of these is far worse than a slow first load: /events/ is the live game
  // event stream and /api/ holds polls open for ~20s. Compressing means buffering.
  for (const path of ['/events/', '/api/']) {
    const body = locationBody(path);
    assert.match(body, /^\s*gzip\s+off\s*;/m, `${path} must set gzip off`);
    assert.match(body, /proxy_buffering\s+off/, `${path} must keep proxy_buffering off`);
  }
  assert.match(locationBody('/events/'), /proxy_cache\s+off/, 'SSE must not be cached');
});

test('if_modified_since only ever gets a value nginx accepts', () => {
  // Regression guard: this directive takes off|exact|before. "on" looks right, parses as a
  // hard error, and would take the whole frontend container down on deploy.
  for (const [, value] of stripComments(conf).matchAll(/if_modified_since\s+(\w+)\s*;/g)) {
    assert.ok(['off', 'exact', 'before'].includes(value),
      `if_modified_since ${value} is not a valid value`);
  }
});
