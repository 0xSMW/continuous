#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
DEPLOY_USER_NAME="${DEPLOY_USER_NAME:-continuous-deploy}"
DEPLOY_PUBLIC_KEY="${DEPLOY_PUBLIC_KEY:-}"
COPY_AUTHORIZED_KEYS_FROM_USER="${COPY_AUTHORIZED_KEYS_FROM_USER:-root}"
ATTEST_AFTER_INSTALL="${ATTEST_AFTER_INSTALL:-true}"
READINESS_ENV_FILE="${READINESS_ENV_FILE:-/etc/continuous/production-readiness.env}"
REMOTE="$SSH_USER@$HOST"
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$SSH_KEY" ]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=45.55.53.92 ./scripts/install-non-root-access.sh" >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") DEPLOY_USER_NAME=$(quote "$DEPLOY_USER_NAME") DEPLOY_PUBLIC_KEY=$(quote "$DEPLOY_PUBLIC_KEY") COPY_AUTHORIZED_KEYS_FROM_USER=$(quote "$COPY_AUTHORIZED_KEYS_FROM_USER") ATTEST_AFTER_INSTALL=$(quote "$ATTEST_AFTER_INSTALL") READINESS_ENV_FILE=$(quote "$READINESS_ENV_FILE") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "install-non-root-access must be run through a root SSH session." >&2
  exit 1
fi

if ! getent group docker >/dev/null; then
  echo "Docker group is missing; deploy Docker before installing non-root access." >&2
  exit 1
fi

if ! id "$DEPLOY_USER_NAME" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups docker "$DEPLOY_USER_NAME"
else
  usermod --append --groups docker "$DEPLOY_USER_NAME"
fi

deploy_home="$(getent passwd "$DEPLOY_USER_NAME" | cut -d: -f6)"
install -m 0700 -o "$DEPLOY_USER_NAME" -g "$DEPLOY_USER_NAME" -d "$deploy_home/.ssh"
authorized_keys="$deploy_home/.ssh/authorized_keys"
touch "$authorized_keys"
chown "$DEPLOY_USER_NAME:$DEPLOY_USER_NAME" "$authorized_keys"
chmod 0600 "$authorized_keys"

if [ -n "$DEPLOY_PUBLIC_KEY" ]; then
  if ! grep -qxF "$DEPLOY_PUBLIC_KEY" "$authorized_keys"; then
    printf '%s\n' "$DEPLOY_PUBLIC_KEY" >> "$authorized_keys"
  fi
else
  source_home="$(getent passwd "$COPY_AUTHORIZED_KEYS_FROM_USER" | cut -d: -f6 || true)"
  source_keys="$source_home/.ssh/authorized_keys"

  if [ ! -f "$source_keys" ]; then
    echo "No DEPLOY_PUBLIC_KEY supplied and no authorized_keys found for $COPY_AUTHORIZED_KEYS_FROM_USER." >&2
    exit 1
  fi

  while IFS= read -r key; do
    if [ -n "$key" ] && ! grep -qxF "$key" "$authorized_keys"; then
      printf '%s\n' "$key" >> "$authorized_keys"
    fi
  done < "$source_keys"
fi

install -m 0755 -d "$APP_DIR"
chown -R "$DEPLOY_USER_NAME:$DEPLOY_USER_NAME" "$APP_DIR"
find "$APP_DIR" -type d -exec chmod u+rwx,go+rx {} +

if [ -d /etc/continuous ]; then
  chmod 0755 /etc/continuous
fi

runuser -u "$DEPLOY_USER_NAME" -- test -w "$APP_DIR"
runuser -u "$DEPLOY_USER_NAME" -- docker compose version >/dev/null

if [ "$ATTEST_AFTER_INSTALL" = "true" ]; then
  if [ ! -x "$APP_DIR/scripts/attest-non-root-access-on-host.sh" ]; then
    echo "Missing $APP_DIR/scripts/attest-non-root-access-on-host.sh. Deploy the latest repo before attesting." >&2
    exit 1
  fi

  APP_DIR="$APP_DIR" \
    DEPLOY_USER_NAME="$DEPLOY_USER_NAME" \
    READINESS_ENV_FILE="$READINESS_ENV_FILE" \
    "$APP_DIR/scripts/attest-non-root-access-on-host.sh"
else
  echo "Installed non-root deploy user $DEPLOY_USER_NAME; attestation skipped."
fi
REMOTE_SCRIPT

echo "Installed non-root deploy access for $DEPLOY_USER_NAME on $HOST."
