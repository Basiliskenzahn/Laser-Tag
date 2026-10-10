# The Python realtime game backend only - no static files, no TLS (nginx in frontend/
# handles both and reverse-proxies /api/* and /events/* here over the private Docker
# network).
FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/

ENV PORT=4000 PYTHONUNBUFFERED=1
EXPOSE 4000

CMD ["python", "-m", "backend.app"]
