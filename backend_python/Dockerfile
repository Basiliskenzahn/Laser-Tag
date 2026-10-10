<<<<<<< HEAD
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "300", "--workers", "1"]
=======
# The realtime game server only - no static files, no TLS (nginx in frontend/ handles both
# and reverse-proxies /ws here over the private Docker network).
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./server/

ENV PORT=4000 NODE_ENV=production
EXPOSE 4000

USER node
CMD ["node", "server/ws-server.js"]
>>>>>>> origin/main
