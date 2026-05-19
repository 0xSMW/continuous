#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
APP_DIR="${APP_DIR:-/opt/continuous}"
SITE_HOSTS="${SITE_HOSTS:-continuoushq.com,www.continuoushq.com}"
ACME_EMAIL="${ACME_EMAIL:-admin@continuoushq.com}"
first_host="${SITE_HOSTS%%,*}"
first_host="${first_host#http://}"
first_host="${first_host#https://}"
APP_URL="${APP_URL:-https://$first_host}"
REMOTE="$SSH_USER@$HOST"

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=203.0.113.10 ./scripts/configure-domain.sh" >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

ssh "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") SITE_HOSTS=$(quote "$SITE_HOSTS") ACME_EMAIL=$(quote "$ACME_EMAIL") APP_URL=$(quote "$APP_URL") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$APP_DIR"
touch .env
chmod 600 .env

set_env() {
  key="$1"
  value="$2"
  tmp="$(mktemp)"

  if grep -q "^${key}=" .env; then
    awk -v key="$key" -v value="$value" '
      index($0, key "=") == 1 { print key "=" value; next }
      { print }
    ' .env > "$tmp"
  else
    cat .env > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi

  mv "$tmp" .env
  chmod 600 .env
}

set_env SITE_HOSTS "$SITE_HOSTS"
set_env ACME_EMAIL "$ACME_EMAIL"
set_env APP_ENV production
set_env APP_URL "$APP_URL"

docker compose up -d --force-recreate caddy
docker compose ps caddy
REMOTE_SCRIPT
