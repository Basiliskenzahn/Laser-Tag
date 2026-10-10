#!/bin/sh
set -eu

# Self-signed cert for the HTTPS server block, generated once into a volume so it persists
# across restarts (phones won't have to re-accept the browser warning every time).
CERT_DIR=/certs
if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -subj "/CN=laser-tag.local" \
    -keyout "$CERT_DIR/key.pem" \
    -out "$CERT_DIR/cert.pem"
fi

exec nginx -g 'daemon off;'
