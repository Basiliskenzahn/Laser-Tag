# Stage 1: just to get the browser runtimes (MediaPipe tasks-vision, ONNX Runtime Web) onto disk -
# nginx has no npm, and the frontend doesn't need anything else from node_modules.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: nginx serves the static client and reverse-proxies /api/* and /events/* to the backend.
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl

COPY frontend/public/ /usr/share/nginx/html/
COPY --from=deps /app/node_modules/@mediapipe/tasks-vision/ /usr/share/nginx/html/vendor/tasks-vision/
COPY --from=deps /app/node_modules/onnxruntime-web/dist/ /usr/share/nginx/html/vendor/ort/
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/common-locations.conf /etc/nginx/common-locations.conf
# Included by every static location in common-locations.conf; without it nginx refuses to start.
COPY frontend/cross-origin-isolation.conf /etc/nginx/cross-origin-isolation.conf
COPY frontend/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 80 443
ENTRYPOINT ["/entrypoint.sh"]
