// Guards the coupling between frontend/Dockerfile and the files it ships.
//
// Both failures below were mutation-proven against the real image layout, and both are
// invisible to every other test in this repo:
//
//   - Deleting `COPY frontend/common-locations.conf` makes nginx refuse to start, because an
//     `include` of a file that is not in the image is a hard error. Frontend down.
//   - Deleting the `include` from nginx.conf instead makes nginx start *fine* and serve
//     nothing but 404s from both server blocks - a total outage wearing a healthy container.
//   - Changing a `COPY --from=deps` destination leaves `npm test`, the image build and
//     `nginx -t` all green, and then reid.js's *static* `import ... from
//     '/vendor/ort/ort.wasm.min.mjs'` 404s, so the module never evaluates and `createReid`
//     simply does not exist. The same shape on detector.js's WASM_PATH takes out object
//     detection, which is the whole game.
//
// Like test/asset-delivery.test.js this is a text check on the shipped files, because
// `npm test` has to keep working on a laptop with no Docker daemon. What it cannot prove is
// that nginx accepts the result - see docs/operations/docker.md for the `nginx -t` route.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => readFileSync(repo(p), 'utf8');

const DOCKERFILE = read('frontend/Dockerfile');

/** Strip `#` comments so a path mentioned in prose cannot satisfy an assertion. */
function stripComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, '').replace(/#.*$/gm, '');
}

/**
 * Every COPY in frontend/Dockerfile as { from, src, dest }. `from` is the build stage for
 * `COPY --from=<stage>`, or null for a plain copy out of the build context.
 */
function copyInstructions() {
  const out = [];
  for (const line of stripComments(DOCKERFILE).split('\n')) {
    const m = line.match(/^\s*COPY\s+(.*)$/i);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    let from = null;
    while (parts[0]?.startsWith('--')) {
      const flag = parts.shift();
      const f = flag.match(/^--from=(.+)$/);
      if (f) from = f[1];
    }
    if (parts.length < 2) continue;
    out.push({ from, dest: parts[parts.length - 1], src: parts.slice(0, -1) });
  }
  return out;
}

const COPIES = copyInstructions();

test('the Dockerfile has COPY instructions at all, or every assertion below is vacuous', () => {
  // Without this, deleting every COPY line would make the rest of this file pass.
  assert.ok(COPIES.length >= 4, `expected several COPY lines, parsed ${COPIES.length}`);
});

// ---- Items 9: every `include` is actually shipped ----

const SHIPPED_CONFIGS = [
  'frontend/nginx.conf',
  'frontend/common-locations.conf',
  'frontend/cross-origin-isolation.conf',
];

/** Every `include /etc/nginx/<something>;` across the shipped configs, with its source. */
function nginxIncludes() {
  const found = [];
  for (const file of SHIPPED_CONFIGS) {
    for (const [, path] of stripComments(read(file)).matchAll(/include\s+(\/etc\/nginx\/[^\s;]+)\s*;/g)) {
      found.push({ file, path });
    }
  }
  return found;
}

test('every include in the shipped configs names a file the Dockerfile copies', () => {
  const includes = nginxIncludes();
  // The configs do include each other, so an empty list means the parser broke rather than
  // that the invariant holds.
  assert.ok(includes.length >= 2, `expected several includes, parsed ${includes.length}`);

  const destinations = new Set(COPIES.map((c) => c.dest));
  for (const { file, path } of includes) {
    const covered = destinations.has(path)
      // A COPY into a directory covers everything beneath it.
      || COPIES.some((c) => c.dest.endsWith('/') && path.startsWith(c.dest));
    assert.ok(
      covered,
      `${file} includes ${path}, but frontend/Dockerfile never copies anything to it - `
      + 'nginx treats a missing include as a hard error and will not start',
    );
  }
});

test('nginx.conf includes common-locations.conf in BOTH server blocks', () => {
  // The one that starts cleanly and serves only 404s. Each server block needs its own
  // include; nothing about nginx would complain if one of them lost it.
  const conf = stripComments(read('frontend/nginx.conf'));
  const blocks = [...conf.matchAll(/server\s*\{/g)];
  assert.equal(blocks.length, 2, 'expected an HTTP and an HTTPS server block');

  const includes = [...conf.matchAll(/include\s+\/etc\/nginx\/common-locations\.conf\s*;/g)];
  assert.equal(
    includes.length,
    2,
    `common-locations.conf is included ${includes.length} time(s) but there are 2 server `
    + 'blocks - a block without it has no location directives at all and answers 404 to '
    + 'everything, while nginx starts and reports healthy',
  );

  // And each one is inside a different block, not two includes in the same block.
  const [first, second] = blocks.map((b) => b.index);
  const positions = includes.map((i) => i.index);
  assert.ok(
    positions.some((p) => p > first && p < second) && positions.some((p) => p > second),
    'both includes are in the same server block',
  );
});

test('the 443 block still has the TLS material the entrypoint generates', () => {
  // If these move, frontend/entrypoint.sh is writing a cert nothing reads.
  const conf = stripComments(read('frontend/nginx.conf'));
  const cert = conf.match(/ssl_certificate\s+(\S+)\s*;/);
  const key = conf.match(/ssl_certificate_key\s+(\S+)\s*;/);
  assert.ok(cert && key, 'the HTTPS server block needs ssl_certificate and ssl_certificate_key');

  const entrypoint = read('frontend/entrypoint.sh');
  const dir = entrypoint.match(/^CERT_DIR=(\S+)/m);
  assert.ok(dir, 'entrypoint.sh must define CERT_DIR');
  for (const [, path] of [cert, key]) {
    assert.ok(
      path.startsWith(`${dir[1]}/`),
      `nginx reads ${path} but entrypoint.sh writes into ${dir[1]}`,
    );
  }
});

// ---- Item 10: every /vendor/ path the client asks for is actually copied ----

/** Where nginx serves files from, taken from nginx.conf's `root`. */
function docRoot() {
  const m = stripComments(read('frontend/nginx.conf')).match(/^\s*root\s+(\S+)\s*;/m);
  assert.ok(m, 'nginx.conf must set a root');
  return m[1].replace(/\/$/, '');
}

/** URL prefixes the deps stage publishes, derived from its COPY destinations. */
function vendoredUrlPrefixes() {
  const root = docRoot();
  return COPIES
    .filter((c) => c.from !== null && c.dest.startsWith(`${root}/`))
    .map((c) => c.dest.slice(root.length));
}

/** Every `/vendor/...` literal the client code asks the server for. */
function requestedVendorPaths() {
  const found = [];
  for (const file of ['frontend/public/reid.js', 'frontend/public/detector.js']) {
    const src = read(file);
    for (const [, url] of src.matchAll(/['"`](\/vendor\/[^'"`]*)['"`]/g)) {
      found.push({ file, url });
    }
  }
  return found;
}

test('the client asks for vendored files, or the check below proves nothing', () => {
  const requested = requestedVendorPaths();
  assert.ok(requested.length >= 3, `expected several /vendor/ literals, found ${requested.length}`);
  // reid.js's is a *static* import: if it 404s the module never evaluates at all.
  assert.ok(
    requested.some((r) => r.file.endsWith('reid.js') && r.url.endsWith('.mjs')),
    "reid.js's static ONNX Runtime import should be among them",
  );
});

test('every /vendor/ path the client requests is covered by a COPY --from=deps', () => {
  const prefixes = vendoredUrlPrefixes();
  assert.ok(
    prefixes.length >= 2,
    `expected the deps stage to publish several prefixes under the doc root, got ${prefixes.length}`,
  );

  for (const { file, url } of requestedVendorPaths()) {
    const covered = prefixes.some((p) => url.startsWith(p) || `${url}/` === p);
    assert.ok(
      covered,
      `${file} requests ${url}, which no "COPY --from=deps" destination covers `
      + `(published prefixes: ${prefixes.join(', ')}). Nothing fails at build time - the `
      + 'file just 404s on a phone.',
    );
  }
});

test('the deps stage copies out of node_modules, and those sources exist when installed', () => {
  const deps = COPIES.filter((c) => c.from !== null);
  assert.ok(deps.length >= 2, 'expected the vendored runtimes to come from a build stage');

  for (const c of deps) {
    for (const src of c.src) {
      assert.match(
        src,
        /node_modules\//,
        `COPY --from=${c.from} ${src}: the deps stage exists to lift browser runtimes out of `
        + 'node_modules',
      );
      // Only checkable where a dependency tree is actually installed; CI runs the suite
      // without one on purpose, so skip rather than fail there.
      const local = src.replace(/^\/app\//, '').replace(/\/$/, '');
      if (!existsSync(repo('node_modules'))) continue;
      assert.ok(
        existsSync(repo(local)),
        `${src} is copied by frontend/Dockerfile but ${local} does not exist - the image `
        + 'build would fail',
      );
    }
  }
});

test('the vendored runtimes are not committed, which is why the COPY is load-bearing', () => {
  // If someone commits frontend/public/vendor/, `COPY frontend/public/` would start covering
  // these paths and the test above would stop meaning anything. Fail loudly instead.
  assert.ok(
    !existsSync(repo('frontend/public/vendor')),
    'frontend/public/vendor/ now exists, so the /vendor/ coverage check above is no longer '
    + 'testing the deps stage - rework it',
  );
});
