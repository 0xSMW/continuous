#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
READINESS_ENV_FILE="${READINESS_ENV_FILE:-/etc/continuous/production-readiness.env}"
SITE_HOST="${SITE_HOST:-continuoushq.com}"
TENANT_SLUG="${TENANT_SLUG:-continuous-demo}"
BOOTSTRAP_CREDENTIAL_ID="${BOOTSTRAP_CREDENTIAL_ID:-bootstrap-operator}"
NEXT_WORKER_RUN_TOKEN="${NEXT_WORKER_RUN_TOKEN:-}"
RUN_ID="${CONTROL_PLANE_ROTATION_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"

cd "$APP_DIR"

env_value() {
  name="$1"
  grep "^${name}=" .env | cut -d= -f2- || true
}

token_fingerprint() {
  printf '%s' "$1" | sha256sum | awk '{print substr($1, 1, 16)}'
}

set_env_file() {
  file="$1"
  key="$2"
  value="$3"
  dir="$(dirname "$file")"
  tmp="$(mktemp)"

  install -m 0700 -d "$dir"
  if [ -f "$file" ]; then
    awk -v key="$key" -v value="$value" '
      index($0, key "=") == 1 { print key "=" value; found = 1; next }
      { print }
      END { if (!found) print key "=" value }
    ' "$file" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi

  mv "$tmp" "$file"
  chmod 0600 "$file"
}

PREVIOUS_WORKER_RUN_TOKEN="$(env_value WORKER_RUN_TOKEN)"

if [ -z "$PREVIOUS_WORKER_RUN_TOKEN" ]; then
  echo "Missing bootstrap token for catalog seeding in $APP_DIR/.env; cannot attest rotation." >&2
  exit 1
fi

if [ -z "$NEXT_WORKER_RUN_TOKEN" ]; then
  echo "NEXT_WORKER_RUN_TOKEN is required." >&2
  exit 1
fi

if [ "$PREVIOUS_WORKER_RUN_TOKEN" = "$NEXT_WORKER_RUN_TOKEN" ]; then
  echo "NEXT_WORKER_RUN_TOKEN must differ from the existing token." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for control-plane token rotation." >&2
  exit 1
fi

ROTATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PREVIOUS_FINGERPRINT="$(token_fingerprint "$PREVIOUS_WORKER_RUN_TOKEN")"
NEXT_FINGERPRINT="$(token_fingerprint "$NEXT_WORKER_RUN_TOKEN")"

ROTATION_PAYLOAD="$(
  jq -nc \
    --arg key "control-plane-token-rotation-$RUN_ID" \
    --arg tenant "$TENANT_SLUG" \
    --arg credentialId "$BOOTSTRAP_CREDENTIAL_ID" \
    --arg previousFingerprint "$PREVIOUS_FINGERPRINT" \
    --arg nextFingerprint "$NEXT_FINGERPRINT" \
    --arg rotatedAt "$ROTATED_AT" '{
      command: "control_plane.token_rotation.attest",
      core: {tenantSlug: $tenant},
      idempotencyKey: $key,
      config: {
        credentialId: $credentialId,
        previousCredentialId: $credentialId,
        previousTokenFingerprint: $previousFingerprint,
        nextTokenFingerprint: $nextFingerprint,
        rotatedAt: $rotatedAt,
        reason: "Deploy-time bootstrap control-plane token rotation.",
        evidence: {
          source: "deploy_control_plane_token_rotation",
          rawTokenStored: false
        }
      }
    }'
)"

ROTATION_RESPONSE="$(
  curl -fsS --resolve "$SITE_HOST:443:127.0.0.1" \
    -X POST "https://$SITE_HOST/core" \
    -H "authorization: Bearer $PREVIOUS_WORKER_RUN_TOKEN" \
    -H "content-type: application/json" \
    -d "$ROTATION_PAYLOAD"
)"

echo "$ROTATION_RESPONSE" | jq -e \
  '.error == null and .data.command == "control_plane.token_rotation.attest" and (.data.result.tokenRotationAttestationId | length > 0) and .data.result.nextTokenFingerprint == "'"$NEXT_FINGERPRINT"'"' \
  >/dev/null

TOKEN_ROTATION_ATTESTATION_ID="$(echo "$ROTATION_RESPONSE" | jq -r '.data.result.tokenRotationAttestationId')"
TOKEN_ROTATION_ATTESTED_AT="$(echo "$ROTATION_RESPONSE" | jq -r '.data.result.attestedAt')"

set_env_file "$READINESS_ENV_FILE" TOKEN_ROTATION_ATTESTED_AT "$TOKEN_ROTATION_ATTESTED_AT"
set_env_file "$READINESS_ENV_FILE" TOKEN_ROTATION_ATTESTATION_ID "$TOKEN_ROTATION_ATTESTATION_ID"

jq -nc \
  --arg checkedAt "$TOKEN_ROTATION_ATTESTED_AT" \
  --arg tokenRotationAttestationId "$TOKEN_ROTATION_ATTESTATION_ID" \
  '{
    control_plane_token_rotation_status: "ok",
    checkedAt: $checkedAt,
    tokenRotationAttestationId: $tokenRotationAttestationId
  }'
