# No build step - this is plain JS served straight to the browser, so one stage is enough.
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The server generates its self-signed cert into .certs/ on first run; the "node" user
# needs to be able to create it.
RUN mkdir -p .certs && chown -R node:node .

# HTTP is for localhost/behind a TLS-terminating proxy; HTTPS is self-signed, for phones on
# the LAN that need camera access straight from the container. See README for both paths.
ENV PORT=3000 HTTPS_PORT=3443 NODE_ENV=production
EXPOSE 3000 3443

USER node
CMD ["node", "server/index.js"]
