// Backend-only entrypoint for the Docker split (see backend/Dockerfile): just the realtime
// game server, no static file serving and no TLS. It's only ever reached over the private
// Docker network, with the frontend's nginx terminating TLS and reverse-proxying /ws here -
// see frontend/nginx.conf. For local (non-Docker) development, use `npm start` instead, which
// runs server/index.js and serves everything from one process.

import http from 'node:http';
import { attachGameServer } from './realtime.js';

const PORT = Number(process.env.PORT) || 4000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('laser-tag backend\n');
});

attachGameServer(server);

server.listen(PORT, () => {
  console.log(`Laser Tag backend listening on ${PORT} (ws path: /ws)`);
});
