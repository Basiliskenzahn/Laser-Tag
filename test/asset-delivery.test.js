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

// ---- Cross-origin isolation (frontend/cross-origin-isolation.conf) ----
//
// reid.js only asks ONNX Runtime for more than one WASM thread when
// `globalThis.crossOriginIsolated` is true, and that is true only when the document arrived
// with COOP + COEP. Nothing served them before, so that branch had never executed and OSNet
// ran single-threaded everywhere. These tests pin the two ways it could silently stop
// working again: the headers going missing, and nginx's add_header inheritance rule quietly
// dropping them from the blocks that matter.

const ISOLATION = fileURLToPath(new URL('../frontend/cross-origin-isolation.conf', import.meta.url));
const isolation = stripComments(readFileSync(ISOLATION, 'utf8'));

/** Every `location` match in the shipped config, in file order. */
function locationMatches() {
  return [...conf.matchAll(/^location\s+(.+?)\s*\{/gm)].map((m) => m[1]);
}

test('cross-origin isolation sets both headers the browser requires', () => {
  // COOP alone does nothing; COEP alone does nothing. crossOriginIsolated needs both.
  assert.match(isolation, /add_header\s+Cross-Origin-Opener-Policy\s+"same-origin"/);
  assert.match(isolation, /add_header\s+Cross-Origin-Embedder-Policy\s+"require-corp"/);
});

test('COEP stays require-corp, which is the only value Safari implements', () => {
  // `credentialless` is laxer and would avoid the cross-origin opt-in requirement, but
  // Safari does not support it and this game is played on phones.
  assert.doesNotMatch(isolation, /Cross-Origin-Embedder-Policy\s+"credentialless"/);
});

test('every header carries "always", or it vanishes on a 304', () => {
  // The models are served with an ETag, so a revalidated model IS a 304. Without `always`,
  // nginx omits add_header on anything that is not a 2xx/3xx body response, and a phone
  // reloading into a warm cache would lose isolation entirely.
  for (const line of isolation.split('\n').filter((l) => l.includes('add_header'))) {
    assert.match(line, /\salways;/, `missing "always": ${line.trim()}`);
  }
});

test('every static location includes the isolation snippet', () => {
  // This is the inheritance trap: `add_header` is inherited only by levels that declare no
  // add_header of their own, and every static block here sets its own Cache-Control. So a
  // server-level COOP/COEP would be dropped exactly where the document is served, with no
  // error. The snippet therefore has to be included per block.
  const proxied = new Set(['/api/', '/events/']);
  for (const match of locationMatches()) {
    if (proxied.has(match)) continue;
    assert.match(
      locationBody(match),
      /include\s+\/etc\/nginx\/cross-origin-isolation\.conf;/,
      `location ${match} serves files but is not cross-origin isolated`,
    );
  }
});

test('the proxied paths are left out of isolation on purpose', () => {
  // /api/ and /events/ answer fetch() and EventSource, not documents. Nothing about
  // isolation applies to them, and adding headers there would only be noise.
  for (const match of ['/api/', '/events/']) {
    assert.doesNotMatch(locationBody(match), /cross-origin-isolation\.conf/);
  }
});

test('the client loads nothing cross-origin, which is what makes require-corp safe', () => {
  // require-corp blocks every cross-origin subresource that does not opt in - a blank
  // screen, not a degraded one. It is safe only while the client is entirely same-origin.
  // If this fails, do not relax the header: give the new resource CORP/CORS, or host it.
  const client = fileURLToPath(new URL('../frontend/public/index.html', import.meta.url));
  const html = readFileSync(client, 'utf8');
  for (const attr of ['src', 'href']) {
    for (const [, url] of html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))) {
      assert.ok(
        !/^(https?:)?\/\//.test(url),
        `index.html loads ${url} cross-origin, which COEP require-corp will block`,
      );
    }
  }
});

test('the Dockerfile ships the snippet, or nginx will not start', () => {
  // An `include` of a file that is not in the image is a hard startup failure, which would
  // take the whole frontend down on deploy rather than degrade it.
  const dockerfile = fileURLToPath(new URL('../frontend/Dockerfile', import.meta.url));
  assert.match(
    readFileSync(dockerfile, 'utf8'),
    /COPY\s+frontend\/cross-origin-isolation\.conf\s+\/etc\/nginx\/cross-origin-isolation\.conf/,
  );
});
