// Combined dev server: serves the phone client AND runs the realtime game, for `npm start`.
// The Docker setup instead splits the static frontend from the Python backend.
//
// It listens twice:
//   HTTP  (PORT, default 3000):        localhost on a laptop, or behind an HTTPS tunnel
//   HTTPS (HTTPS_PORT, default 3443):  phones on the same Wi-Fi (self-signed certificate)
// Phones only allow camera access on HTTPS pages, so plain HTTP only works on localhost.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { handleHttp } from './realtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const CERT_DIR = path.join(ROOT, '.certs');

// URL prefix -> directory on disk.
const STATIC_DIRS = [
  ['/vendor/tasks-vision/', path.join(ROOT, 'node_modules/@mediapipe/tasks-vision/')],
  ['/', path.join(ROOT, 'public/')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  for (const [prefix, dir] of STATIC_DIRS) {
    if (!urlPath.startsWith(prefix)) continue;
    let file = path.join(dir, urlPath.slice(prefix.length));
    if (!file.startsWith(dir)) break; // path traversal
    if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
    return;
  }
  res.writeHead(404).end('Not found');
}

async function loadCertificate() {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 1);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'laser-tag.local' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate,
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

// /api/* and /events/* are the local game backend; everything else is a static file.
const handleRequest = (req, res) => handleHttp(req, res) || serveStatic(req, res);
const httpServer = http.createServer(handleRequest);
const httpsServer = https.createServer(await loadCertificate(), handleRequest);

httpServer.listen(PORT, () => {
  httpsServer.listen(HTTPS_PORT, () => {
    console.log('\nLaser Tag server running\n');
    console.log(`  Laptop:  http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  Phones:  https://${ip}:${HTTPS_PORT}`);
    console.log('\nPhones will warn about the self-signed certificate. Accept it to continue.');
    console.log(`For a trusted HTTPS URL instead, run: cloudflared tunnel --url http://localhost:${PORT}\n`);
  });
});
