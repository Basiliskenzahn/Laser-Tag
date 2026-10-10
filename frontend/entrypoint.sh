#!/bin/sh
set -eu

# Self-signed cert for the HTTPS server block, kept in a volume so phones only have to accept
# the browser warning once. Full rationale: docs/operations/docker.md#tls-certificate
CERT_DIR=/certs
CERT="$CERT_DIR/cert.pem"
KEY="$CERT_DIR/key.pem"
# Written last, and cleared first, so its presence means "a matching pair was published".
MARKER="$CERT_DIR/cert.sans"

# The only name that matters for LAN play is the address a phone types - the host's LAN IP,
# which is not knowable at build time. Set CERT_HOSTS in docker-compose.yml to add it.
CERT_HOSTS="${CERT_HOSTS:-DNS:laser-tag.local,DNS:localhost,IP:127.0.0.1}"
RENEW_BEFORE_SECONDS="${CERT_RENEW_BEFORE_SECONDS:-2592000}" # 30 days

cert_is_usable() {
  [ -s "$CERT" ] && [ -s "$KEY" ] || return 1
  # Covers two things at once: that CERT_HOSTS has not been edited since the cert was
  # written, and that the last generation ran to completion. nginx refuses to start on a
  # cert and key that do not match, and that state is otherwise unreachable by any check on
  # the files themselves - a half-published pair is two individually valid files.
  [ "$(cat "$MARKER" 2>/dev/null)" = "$CERT_HOSTS" ] || return 1
  # Non-zero on a near-expired cert and on an unparseable one alike. Expiry has to be checked
  # rather than mere existence: an expired cert still starts nginx and still gets served on
  # 443, which mobile browsers refuse far less forgivingly than untrusted-but-valid.
  openssl x509 -checkend "$RENEW_BEFORE_SECONDS" -noout -in "$CERT" >/dev/null 2>&1
}

if ! cert_is_usable; then
  mkdir -p "$CERT_DIR"
  echo "entrypoint: generating a self-signed certificate for $CERT_HOSTS" >&2
  rm -f "$MARKER"
  # subjectAltName, not just a commonName: modern browsers ignore CN entirely, and an
  # exception a phone accepts only sticks for a name the certificate actually claims.
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -subj "/CN=laser-tag.local" \
    -addext "subjectAltName=$CERT_HOSTS" \
    -keyout "$CERT_DIR/.key.pem.new" \
    -out "$CERT_DIR/.cert.pem.new" 2>/dev/null
  # rename(2) inside the volume is atomic, so a kill here leaves whole files rather than
  # truncated ones, and the absent marker means the next boot regenerates the pair.
  mv "$CERT_DIR/.key.pem.new" "$KEY"
  mv "$CERT_DIR/.cert.pem.new" "$CERT"
  printf '%s' "$CERT_HOSTS" > "$MARKER"
fi

exec nginx -g 'daemon off;'
