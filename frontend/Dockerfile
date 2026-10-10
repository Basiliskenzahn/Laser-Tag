# Stage 1: just to get @mediapipe/tasks-vision's static assets (wasm + JS bundle) onto disk -
# nginx has no npm, and the frontend doesn't need anything else from node_modules.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: nginx serves the static client and reverse-proxies /api/* and /events/* to the backend.
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl

COPY public/ /usr/share/nginx/html/
COPY --from=deps /app/node_modules/@mediapipe/tasks-vision/ /usr/share/nginx/html/vendor/tasks-vision/
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/common-locations.conf /etc/nginx/common-locations.conf
COPY frontend/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80 443
ENTRYPOINT ["/entrypoint.sh"]
