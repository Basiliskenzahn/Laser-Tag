// The three deploy-killers that text checks have actually caught, and nothing else.
//
// This replaces ~654 lines across deploy-robustness.test.js, config-shipping.test.js and
// asset-delivery.test.js. Those files read the shipped config and Dockerfiles as text and
// regexed over them - they never ran a line of game logic - and each one said in its own
// header that it could not prove nginx or Compose accepts the result. Most of their
// assertions restated a directive back to itself.
//
// But three of them earned their place by catching real failures, so those survive here:
//
//   1. `if_modified_since on` is invalid (the values are off|exact|before). nginx refuses to
//      start, so the frontend container crash-loops on deploy. This was a live bug once.
//   2. An `include` of a file the image does not COPY is also a hard startup failure.
//   3. A vendored COPY destination that does not cover the /vendor/ URLs the client imports
//      404s *only on a phone*: npm test, the build and `nginx -t` all stay green, then
//      reid.js's static import fails and createReid never exists.
//
// What this cannot do is prove the config is valid. That is `nginx -t`, documented in
// docs/operations/docker.md - and genuinely runnable, which is why the rest went.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const strip = (s) => s.replace(/^[ \t]*#.*$/gm, '');

const CONFS = ['frontend/nginx.conf', 'frontend/common-locations.conf', 'frontend/cross-origin-isolation.conf'];
const DOCKERFILE = read('frontend/Dockerfile');

test('if_modified_since only ever gets a value nginx accepts', () => {
  const valid = new Set(['off', 'exact', 'before']);
  let seen = 0;
  for (const conf of CONFS) {
    for (const [, value] of strip(read(conf)).matchAll(/if_modified_since\s+(\w+)\s*;/g)) {
      seen += 1;
      assert.ok(valid.has(value), `if_modified_since ${value} is not a valid value`);
    }
  }
  assert.ok(seen > 0, 'parsed no if_modified_since directives, so this asserted nothing');
});

test('every include the config asks for is a file the image copies', () => {
  const destinations = [...DOCKERFILE.matchAll(/^\s*COPY\s+(?:--from=\S+\s+)?\S+\s+(\S+)/gim)].map((m) => m[1]);
  const includes = [];
  for (const conf of CONFS) {
    for (const [, path] of strip(read(conf)).matchAll(/include\s+(\/etc\/nginx\/[^\s;]+)\s*;/g)) includes.push(path);
  }
  assert.ok(includes.length >= 2, `parsed ${includes.length} includes, expected several`);
  for (const path of includes) {
    assert.ok(destinations.includes(path), `${path} is included but never COPYed into the image`);
  }
});

test('the vendored COPY destinations cover every /vendor/ URL the client imports', () => {
  const prefixes = [...DOCKERFILE.matchAll(/^\s*COPY\s+--from=\S+\s+\S+\s+(\S+)/gim)]
    .map((m) => m[1].replace(/^\/usr\/share\/nginx\/html/, '').replace(/\/?$/, '/'));
  assert.ok(prefixes.length >= 2, 'expected the vendored runtimes to come from a build stage');

  const requested = new Set();
  for (const file of ['frontend/public/reid.js', 'frontend/public/detector.js']) {
    for (const [, url] of read(file).matchAll(/['"](\/vendor\/[^'"]+)['"]/g)) requested.add(url);
  }
  assert.ok(requested.size >= 2, `found ${requested.size} /vendor/ literals, expected several`);
  for (const url of requested) {
    assert.ok(prefixes.some((p) => url.startsWith(p)), `${url} is requested but no COPY destination covers it`);
  }
});
