#!/bin/sh
set -eu

# Self-signed cert for the HTTPS server block, kept in a volume so it persists across
# restarts (phones won't have to re-accept the browser warning every time).
CERT_DIR=/certs
CERT="$CERT_DIR/cert.pem"
KEY="$CERT_DIR/key.pem"

# What the certificate claims to be. Overridable because the only name that matters for LAN
# play is the address a phone actually types, and that is the host's LAN IP - which is not
# knowable at build time. Set CERT_HOSTS in docker-compose.yml to add it, e.g.
#   CERT_HOSTS=DNS:laser-tag.local,DNS:localhost,IP:127.0.0.1,IP:192.168.1.20
CERT_HOSTS="${CERT_HOSTS:-DNS:laser-tag.local,DNS:localhost,IP:127.0.0.1}"

# Regenerate this long before notAfter rather than only when the files are missing. The old
# guard was existence-only against `-days 365`, so on day 366 nginx still started and still
# served 443 - with an *expired* certificate, which mobile browsers treat far less
# forgivingly than an untrusted-but-valid one, and nothing anywhere would have reported it.
RENEW_BEFORE_SECONDS="${CERT_RENEW_BEFORE_SECONDS:-2592000}" # 30 days

# The SAN list the cert on disk was built from. Without this, editing CERT_HOSTS would
# silently do nothing for the life of the volume, because the old cert is still valid.
SANS_MARKER="$CERT_DIR/cert.sans"

cert_is_usable() {
  [ -s "$CERT" ] && [ -s "$KEY" ] || return 1
  # `-checkend` exits non-zero both when the cert is inside the renewal window AND when it
  # cannot be parsed at all, so this single call also covers the half-written case: a
  # container killed mid-openssl used to leave two files that satisfied the existence guard
  # forever, after which nginx failed to start on every boot with no fix but
  # `docker volume rm`. The key is checked separately - a truncated key is invisible to a
  # check on the cert, and nginx needs both.
  openssl x509 -checkend "$RENEW_BEFORE_SECONDS" -noout -in "$CERT" >/dev/null 2>&1 || return 1
  openssl pkey -in "$KEY" -noout >/dev/null 2>&1 || return 1
  [ "$(cat "$SANS_MARKER" 2>/dev/null || true)" = "$CERT_HOSTS" ] || return 1
}

if ! cert_is_usable; then
  mkdir -p "$CERT_DIR"
  echo "entrypoint: generating a self-signed certificate for $CERT_HOSTS" >&2
  # subjectAltName, not just a commonName: modern browsers ignore CN entirely, so the old
  # "/CN=laser-tag.local" cert failed hostname validation from the day it was generated -
  # and an exception a phone accepts only sticks for a name the certificate actually claims.
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -subj "/CN=laser-tag.local" \
    -addext "subjectAltName=$CERT_HOSTS" \
    -keyout "$CERT_DIR/.key.pem.new" \
    -out "$CERT_DIR/.cert.pem.new" 2>/dev/null
  # Publish only once both halves are complete. rename(2) inside the volume is atomic, so a
  # kill during generation now leaves the previous usable pair (or nothing at all) instead of
  # a truncated file that the guard above would have to clean up on the next boot.
  mv "$CERT_DIR/.key.pem.new" "$KEY"
  mv "$CERT_DIR/.cert.pem.new" "$CERT"
  printf '%s' "$CERT_HOSTS" > "$SANS_MARKER"
fi

exec nginx -g 'daemon off;'
