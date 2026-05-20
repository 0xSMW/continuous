#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
APP_DIR="${APP_DIR:-/opt/continuous}"
APP_TAG="${APP_TAG:-${ROLLBACK_APP_TAG:-}}"
REMOTE="$SSH_USER@$HOST"

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=45.55.53.92 APP_TAG=sha-abc123 ./scripts/rollback-app.sh" >&2
  exit 1
fi

if [ -z "$APP_TAG" ]; then
  echo "Set APP_TAG or ROLLBACK_APP_TAG to an existing deployed image tag." >&2
  exit 1
fi

if [[ ! "$APP_TAG" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "APP_TAG may only contain letters, numbers, dot, underscore, or dash." >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

ssh "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") ROLLBACK_APP_TAG=$(quote "$APP_TAG") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; cannot roll back app services." >&2
  exit 1
fi

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

app_image="$(grep '^APP_IMAGE=' .env | cut -d= -f2- || true)"
app_image="${app_image:-continuous-app}"
current_tag="$(grep '^APP_TAG=' .env | cut -d= -f2- || true)"

if [ "$current_tag" = "$ROLLBACK_APP_TAG" ]; then
  echo "APP_TAG is already $ROLLBACK_APP_TAG."
else
  docker image inspect "$app_image:$ROLLBACK_APP_TAG" >/dev/null
  docker image inspect "$app_image:$ROLLBACK_APP_TAG-scheduler" >/dev/null
  if [ -n "$current_tag" ]; then
    set_env PREVIOUS_APP_TAG "$current_tag"
  fi
  set_env APP_TAG "$ROLLBACK_APP_TAG"
fi

docker compose --profile scheduler up -d --no-build --no-deps app worker-scheduler
for attempt in $(seq 1 30); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))" </dev/null; then
    docker compose --profile scheduler ps app worker-scheduler
    exit 0
  fi
  sleep 5
done

echo "App did not become healthy after rollback to $ROLLBACK_APP_TAG." >&2
docker compose --profile scheduler ps app worker-scheduler >&2
exit 1
REMOTE_SCRIPT
