// Guards the deploy and container decisions in docker-compose.yml, the CI workflow and
// frontend/entrypoint.sh. Every one of these is a config line whose absence produces no
// error anywhere - the stack keeps building, the suite keeps passing, and the failure only
// shows up as an outage, as a silent wrong-code deploy, or a year later as an expired cert.
//
// Text checks for the same reason as test/asset-delivery.test.js: `npm test` must work with
// no Docker daemon. They cannot prove Compose accepts the file; see docs/operations/.

import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p) => readFileSync(repo(p), 'utf8');

/**
 * Strip `#` comments. This matters in both directions here: prose explaining a setting must
 * not stand in for the setting, and - the way this file first failed - a comment explaining
 * why `git pull` and `docker compose run` are gone must not trip the assertions that they
 * are gone. Shell comments inside a `run: |` block are stripped the same way.
 */
function stripComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, '').replace(/(?<![$'"])#(?![{])[^\n]*$/gm, '');
}

const COMPOSE = stripComments(read('docker-compose.yml'));
const ENTRYPOINT = stripComments(read('frontend/entrypoint.sh'));

/**
 * One top-level service's YAML body out of docker-compose.yml, by indentation: everything
 * from `  <name>:` until the next line indented two spaces or less.
 */
function serviceBody(name) {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `no service "${name}" in docker-compose.yml`);
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*$/.test(lines[i])) { body.push(lines[i]); continue; }
    if (!/^ {4}/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/** The services the game actually runs - not the `test` profile ones. */
const RUNTIME_SERVICES = ['backend', 'frontend'];

// ---- Item 1: restart policy ----

test('both runtime services restart on their own', () => {
  // The only thing that starts this stack is a CI deploy, and CI only runs on a push. So
  // without this, a host reboot, a daemon restart or an OOM kill took the game down until a
  // human noticed and redeployed.
  for (const name of RUNTIME_SERVICES) {
    const restart = serviceBody(name).match(/^\s{4}restart:\s*(\S+)/m);
    assert.ok(restart, `${name} has no restart policy`);
    assert.ok(
      ['unless-stopped', 'always'].includes(restart[1]),
      `${name} has restart: ${restart[1]}, which does not survive a reboot`,
    );
  }
});

test('the test-profile services are deliberately left without a restart policy', () => {
  // A one-shot test run that restarts forever would be its own outage.
  for (const name of ['tests', 'backend-tests']) {
    assert.doesNotMatch(
      serviceBody(name),
      /^\s{4}restart:/m,
      `${name} is a one-shot run and must not have a restart policy`,
    );
  }
});

// ---- Item 2: readiness, not just "started" ----

test('the backend has a healthcheck that probes it over HTTP', () => {
  const body = serviceBody('backend');
  assert.match(body, /^\s{4}healthcheck:/m, 'the backend needs a healthcheck');
  // It has to actually reach the server. A healthcheck of `true` would satisfy a looser test.
  assert.match(body, /127\.0\.0\.1:4000|localhost:4000/, 'the probe must connect to port 4000');
  // python:3.12-slim ships neither curl nor wget, so a probe naming one would never run.
  const probe = body.slice(body.indexOf('healthcheck:'));
  assert.doesNotMatch(
    probe.split(/^\s{4}\w/m)[0],
    /\b(curl|wget)\b/,
    'python:3.12-slim has no curl and no wget - use python itself',
  );
});

test('the frontend waits for the backend to be HEALTHY, not merely started', () => {
  // The short list form (`depends_on: [backend]`) waits only for the container to be created
  // and started, so every deploy had a window where nginx was up and backend:4000 refused -
  // 502 on /api/ and /events/ at once, which is a phone's poll loop and its SSE stream.
  const body = serviceBody('frontend');
  const dep = body.match(/depends_on:\s*\n((?:\s{6,}.*\n?)+)/);
  assert.ok(dep, 'the frontend must depend on the backend');
  assert.match(
    dep[1],
    /backend:\s*\n\s+condition:\s*service_healthy/,
    'depends_on must use the long form with condition: service_healthy',
  );
  assert.doesNotMatch(dep[1], /^\s*-\s*backend\s*$/m, 'the short list form does not wait for readiness');
});

test('the backend health route the probe uses is the one the app actually serves', () => {
  // Cross-checked against backend/app.py rather than restated, so moving the route breaks
  // this instead of breaking the deploy.
  const app = read('backend/app.py');
  const route = app.match(/add_get\(\s*["'](\/)["']\s*,\s*health\s*\)/);
  assert.ok(route, 'backend/app.py no longer routes GET / to health()');

  // Compare the probe's URL *path*, not just that the string appears: a probe pointed at
  // /healthz still contains "127.0.0.1:4000/" and slipped past an earlier version of this.
  const url = serviceBody('backend').match(/['"]http:\/\/127\.0\.0\.1:4000(\/[^'"]*)['"]/);
  assert.ok(url, 'could not find the healthcheck URL in the backend service');
  assert.equal(
    url[1],
    route[1],
    `the healthcheck requests ${url[1]} but backend/app.py routes health() at ${route[1]}, `
    + 'so the probe would 404 and the container would never report healthy',
  );

  // And it must stay unreachable from outside: nginx proxies only /api/ and /events/.
  const nginx = read('frontend/common-locations.conf');
  const proxied = [...nginx.matchAll(/^location\s+(\S+)\s*\{[^}]*proxy_pass/gms)].map((m) => m[1]);
  assert.ok(
    !proxied.includes('/'),
    'nginx proxies / to the backend, which would publish the health route',
  );
});

// ---- Item 3 and 4: the deploy trigger, and a real test gate ----




test('package.json and the compose test service agree on one node major', () => {
  // Cross-checked against each other rather than against a number written here, so this
  // fails when they drift apart instead of when they are all updated together.
  //
  // CI is deliberately NOT part of this check: the workflow is shared infrastructure and was
  // reverted out of this branch so the game-fix PR carries no CI diff. The version that also
  // pins setup-node to this major lives on `luxkaiwalker/deploy-robustness`. If that lands,
  // add the `node-version:` arm back.
  const pkg = JSON.parse(read('package.json'));
  const floor = pkg.engines.node.match(/(\d+)/);
  assert.ok(floor, 'package.json must declare an engines.node floor');

  const composeImage = serviceBody('tests').match(/image:\s*node:(\d+)/);
  assert.ok(composeImage, 'the compose tests service must pin a node image');

  assert.equal(composeImage[1], floor[1], 'the compose tests image disagrees with engines.node');

  // The test script passes a quoted glob for the runner itself to expand, which node 20's
  // test runner cannot do at all - it exits with "Could not find 'test/**/*.test.js'".
  if (/--test\s+"[^"]*\*\*/.test(pkg.scripts.test)) {
    assert.ok(
      Number(floor[1]) >= 22,
      'the test script relies on node expanding a recursive glob, which needs node >= 22',
    );
  }
});

// ---- Item 5: the deploy must be reproducible ----



// ---- Item 6: the certificate ----

test('the cert is regenerated on expiry, not merely when the file is missing', () => {
  // The old guard was `[ ! -f cert.pem ] || [ ! -f key.pem ]` with -days 365, so on day 366
  // nginx still started and still served 443 with an expired cert - which phone browsers
  // refuse far less forgivingly than an untrusted-but-valid one.
  assert.match(
    ENTRYPOINT,
    /openssl\s+x509\s+-checkend/,
    'the guard must test expiry with `openssl x509 -checkend`',
  );
  // Resolve the argument to a number. An earlier version of this test read the *variable
  // name* off `-checkend "$RENEW_BEFORE_SECONDS"` and compared that to '0', so setting
  // `RENEW_BEFORE_SECONDS=0` sailed straight through it.
  const arg = ENTRYPOINT.match(/-checkend\s+"?\$?\{?([A-Za-z_][\w]*|\d+)/);
  assert.ok(arg, 'could not read the -checkend argument');
  let seconds = Number(arg[1]);
  if (Number.isNaN(seconds)) {
    const assigned = ENTRYPOINT.match(
      new RegExp(`^${arg[1]}=(?:"\\$\\{\\w+:-(\\d+)\\}"|"?(\\d+)"?)`, 'm'),
    );
    assert.ok(assigned, `${arg[1]} is passed to -checkend but never assigned a number`);
    seconds = Number(assigned[1] ?? assigned[2]);
  }
  // A window of 0 only notices a cert that has ALREADY expired - i.e. after 443 has started
  // serving it, which is the outage this is meant to prevent. Renew with real headroom.
  assert.ok(
    seconds >= 86400,
    `-checkend is ${seconds}s: that renews only once the cert has essentially expired, `
    + 'so nginx still gets to serve an expired certificate to a phone',
  );
});

test('a half-written cert or key cannot wedge the container forever', () => {
  // If openssl was killed mid-write, the old existence-only guard passed forever and nginx
  // failed to start on every boot, with no fix but `docker volume rm`. So openssl writes to
  // temporary names and the pair is published with mv; rename(2) in the volume is atomic.
  assert.match(
    ENTRYPOINT,
    /^\s*mv\s+/m,
    'generate to a temporary name and mv into place - rename(2) in the volume is atomic',
  );
  const keyout = ENTRYPOINT.match(/-keyout\s+"([^"]+)"/);
  const out = ENTRYPOINT.match(/-out\s+"([^"]+)"/);
  assert.ok(keyout && out, 'could not read the openssl output paths');
  for (const [, path] of [keyout, out]) {
    assert.ok(
      !/\/(cert|key)\.pem"?$/.test(path),
      `openssl writes straight to ${path}, so a kill mid-write leaves a truncated file in place`,
    );
  }
});

test('the SAN marker is cleared before the renames and written after both', () => {
  // Two renames are not one atomic operation: a kill between them leaves a NEW key beside
  // the OLD cert - two individually valid, individually parseable files that nginx refuses
  // to start on ("key values mismatch"). Nothing about either file reveals it, so the marker
  // doubles as the commit record for the pair. Only this order works: writing it before the
  // mv's, or never clearing it, reopens the wedge. (An `openssl pkey` probe on the key was
  // tried instead and does not help - the new key parses perfectly.)
  const marker = ENTRYPOINT.match(/^(\w+)="\$CERT_DIR\/cert\.sans"/m);
  assert.ok(marker, 'the entrypoint must keep a marker file alongside the pair');
  const rm = ENTRYPOINT.search(new RegExp(`^\\s*rm\\s+-f\\s+"\\$${marker[1]}"`, 'm'));
  const mvs = [...ENTRYPOINT.matchAll(/^\s*mv\s+.*$/gm)];
  const write = ENTRYPOINT.search(new RegExp(`>\\s*"\\$${marker[1]}"`, 'm'));

  assert.notEqual(rm, -1, `${marker[1]} must be cleared before the pair is republished`);
  assert.equal(mvs.length, 2, 'expected the key and the cert to each be moved into place');
  assert.notEqual(write, -1, `${marker[1]} must be written after a successful generation`);
  assert.ok(rm < mvs[0].index, 'the marker must be cleared before the first mv');
  assert.ok(write > mvs[1].index, 'the marker must be written after the last mv');
});

test('the cert carries a subjectAltName, which is the only name a browser reads', () => {
  // Modern browsers ignore commonName entirely, so the old "/CN=laser-tag.local" cert failed
  // hostname validation from the day it was generated - and an exception a phone accepts only
  // sticks for a name the certificate actually claims.
  assert.match(ENTRYPOINT, /-addext\s+"subjectAltName=/, 'openssl req must set a SAN');
  const san = ENTRYPOINT.match(/CERT_HOSTS="\$\{CERT_HOSTS:-([^"}]+)\}"/);
  assert.ok(san, 'the SAN list should be overridable, since the LAN IP is not knowable here');
  assert.match(san[1], /DNS:/, 'the SAN needs at least one DNS name');
  assert.match(san[1], /IP:/, 'a phone on the LAN types an IP, which CN never covered');
});

// ---- Item 11: the compose test run does no pointless work ----

test('the compose test service does not reinstall dependencies it never imports', () => {
  // Nothing in the suite resolves a bare specifier, so `npm ci` downloaded ~180 MB of
  // MediaPipe and ONNX Runtime for nothing - and because it wipes node_modules first, the
  // test-node-modules volume cached nothing either.
  const body = serviceBody('tests');
  assert.doesNotMatch(body, /npm\s+(ci|install)/, 'the test run needs no dependency install');
  assert.match(body, /npm test/, 'it still has to run the tests');
});

test('no test file imports a bare specifier, which is what makes the above safe', () => {
  // If this ever fails, put `npm ci` back rather than deleting this test.
  const files = globSync('test/**/*.test.js', { cwd: repo('.') })
    .concat('frontend/public/identify.test.js');
  assert.ok(files.length >= 9, `expected the suite's files, found ${files.length}`);
  for (const file of files) {
    for (const [, spec] of read(file).matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(
        spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:'),
        `${file} imports the bare specifier "${spec}", which needs node_modules - the `
        + 'compose tests service no longer installs any',
      );
    }
  }
});
