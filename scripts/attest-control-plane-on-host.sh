#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
READINESS_ENV_FILE="${READINESS_ENV_FILE:-/etc/continuous/production-readiness.env}"
SITE_HOST="${SITE_HOST:-continuoushq.com}"
TENANT_SLUG="${TENANT_SLUG:-continuous-demo}"
BOOTSTRAP_CREDENTIAL_ID="${BOOTSTRAP_CREDENTIAL_ID:-bootstrap-operator}"
RUN_ID="${CONTROL_PLANE_ATTESTATION_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"

cd "$APP_DIR"

env_value() {
  name="$1"
  grep "^${name}=" .env | cut -d= -f2- || true
}

WORKER_TOKEN="$(env_value WORKER_RUN_TOKEN)"
WORKER_OPERATOR_EMAIL="$(env_value WORKER_OPERATOR_EMAIL)"
WORKER_OPERATOR_EMAIL="${WORKER_OPERATOR_EMAIL:-owner@continuoushq.com}"

if [ -z "$WORKER_TOKEN" ]; then
  echo "Missing bootstrap token for catalog seeding in $APP_DIR/.env." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for control-plane attestation." >&2
  exit 1
fi

token_fingerprint() {
  printf '%s' "$1" | sha256sum | awk '{print substr($1, 1, 16)}'
}

core_post() {
  payload="$1"

  curl -fsS --resolve "$SITE_HOST:443:127.0.0.1" \
    -X POST "https://$SITE_HOST/core" \
    -H "authorization: Bearer $WORKER_TOKEN" \
    -H "content-type: application/json" \
    -d "$payload"
}

set_env_file() {
  file="$1"
  key="$2"
  value="$3"
  dir="$(dirname "$file")"
  tmp="$(mktemp)"

  if [ ! -d "$dir" ]; then
    install -m 0700 -d "$dir"
  fi

  if [ -f "$file" ]; then
    awk -v key="$key" -v value="$value" '
      index($0, key "=") == 1 { print key "=" value; found = 1; next }
      { print }
      END { if (!found) print key "=" value }
    ' "$file" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi

  cat "$tmp" > "$file"
  rm -f "$tmp"
  chmod 0600 "$file"
}

BOOTSTRAP_FINGERPRINT="$(token_fingerprint "$WORKER_TOKEN")"
CONTROL_PLANE_ATTESTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

BOOTSTRAP_PAYLOAD="$(
  jq -nc \
    --arg key "control-plane-credential-upsert-$RUN_ID" \
    --arg tenant "$TENANT_SLUG" \
    --arg credentialId "$BOOTSTRAP_CREDENTIAL_ID" \
    --arg operatorEmail "$WORKER_OPERATOR_EMAIL" \
    --arg fingerprint "$BOOTSTRAP_FINGERPRINT" '{
      command: "control_plane.credential.upsert",
      core: {tenantSlug: $tenant},
      idempotencyKey: $key,
      config: {
        credentialId: $credentialId,
        displayName: "Bootstrap operator",
        operatorEmail: $operatorEmail,
        tokenFingerprint: $fingerprint,
        allowedTenants: [$tenant],
        allowedWorkerRoles: [
          "revenue_operations",
          "owner_chief_of_staff",
          "dispatch_operations",
          "finance_operations"
        ],
        allowedRoutes: ["core", "worker", "workflow", "approval"],
        allowedAccess: ["read", "write"],
        allowedCommands: ["core:*", "worker:*", "workflow:*", "approval:*"],
        evidence: {
          source: "deploy_control_plane_attestation",
          rawTokenStored: false,
          catalogCredentialId: $credentialId
        }
      }
    }'
)"
BOOTSTRAP_RESPONSE="$(core_post "$BOOTSTRAP_PAYLOAD")"
echo "$BOOTSTRAP_RESPONSE" | jq -e \
  '.error == null and .data.command == "control_plane.credential.upsert" and (.data.result.controlPlaneCredentialId | length > 0) and .data.result.credential.state == "active"' \
  >/dev/null
CONTROL_PLANE_CREDENTIAL_ROW_ID="$(echo "$BOOTSTRAP_RESPONSE" | jq -r '.data.result.controlPlaneCredentialId')"

DRILL_CREDENTIAL_ID="deploy-revocation-drill-$RUN_ID"
DRILL_FINGERPRINT="$(token_fingerprint "$DRILL_CREDENTIAL_ID")"
DRILL_UPSERT_PAYLOAD="$(
  jq -nc \
    --arg key "control-plane-revocation-drill-upsert-$RUN_ID" \
    --arg tenant "$TENANT_SLUG" \
    --arg credentialId "$DRILL_CREDENTIAL_ID" \
    --arg operatorEmail "$WORKER_OPERATOR_EMAIL" \
    --arg fingerprint "$DRILL_FINGERPRINT" '{
      command: "control_plane.credential.upsert",
      core: {tenantSlug: $tenant},
      idempotencyKey: $key,
      config: {
        credentialId: $credentialId,
        displayName: "Deploy revocation drill credential",
        operatorEmail: $operatorEmail,
        tokenFingerprint: $fingerprint,
        allowedTenants: [$tenant],
        allowedWorkerRoles: ["revenue_operations"],
        allowedRoutes: ["worker"],
        allowedAccess: ["read"],
        allowedCommands: ["worker:view.snapshot"],
        evidence: {
          source: "deploy_control_plane_revocation_drill",
          rawTokenStored: false
        }
      }
    }'
)"
DRILL_UPSERT_RESPONSE="$(core_post "$DRILL_UPSERT_PAYLOAD")"
echo "$DRILL_UPSERT_RESPONSE" | jq -e \
  '.error == null and .data.command == "control_plane.credential.upsert" and (.data.result.controlPlaneCredentialId | length > 0)' \
  >/dev/null

DRILL_REVOKE_PAYLOAD="$(
  jq -nc \
    --arg key "control-plane-revocation-drill-revoke-$RUN_ID" \
    --arg tenant "$TENANT_SLUG" \
    --arg credentialId "$DRILL_CREDENTIAL_ID" '{
      command: "control_plane.credential.revoke",
      core: {tenantSlug: $tenant},
      idempotencyKey: $key,
      config: {
        credentialId: $credentialId,
        reason: "Deploy smoke revocation drill for managed control-plane credential inventory.",
        evidence: {
          source: "deploy_control_plane_revocation_drill",
          rawTokenStored: false
        }
      }
    }'
)"
DRILL_REVOKE_RESPONSE="$(core_post "$DRILL_REVOKE_PAYLOAD")"
echo "$DRILL_REVOKE_RESPONSE" | jq -e \
  '.error == null and .data.command == "control_plane.credential.revoke" and (.data.result.auditEventId | length > 0) and .data.result.credential.state == "revoked"' \
  >/dev/null
CONTROL_PLANE_REVOCATION_AUDIT_ID="$(echo "$DRILL_REVOKE_RESPONSE" | jq -r '.data.result.auditEventId')"

SESSION_REVIEW_PAYLOAD="$(
  jq -nc \
    --arg key "control-plane-session-review-$RUN_ID" \
    --arg tenant "$TENANT_SLUG" \
    --arg credentialId "$BOOTSTRAP_CREDENTIAL_ID" '{
      command: "control_plane.session.review",
      core: {tenantSlug: $tenant},
      idempotencyKey: $key,
      config: {
        credentialId: $credentialId,
        limit: 50
      }
    }'
)"
SESSION_REVIEW_RESPONSE="$(core_post "$SESSION_REVIEW_PAYLOAD")"
echo "$SESSION_REVIEW_RESPONSE" | jq -e \
  '.error == null and .data.command == "control_plane.session.review" and (.data.result.reviewViewId | length > 0) and (.data.result.sessions | length) >= 1' \
  >/dev/null
CONTROL_PLANE_SESSION_REVIEW_VIEW_ID="$(echo "$SESSION_REVIEW_RESPONSE" | jq -r '.data.result.reviewViewId')"
CONTROL_PLANE_AUTH_SESSION_ID="$(echo "$SESSION_REVIEW_RESPONSE" | jq -r '.data.result.sessions[0].id')"

set_env_file "$READINESS_ENV_FILE" CONTROL_PLANE_AUTH_AUDIT_ATTESTED_AT "$CONTROL_PLANE_ATTESTED_AT"
set_env_file "$READINESS_ENV_FILE" CONTROL_PLANE_AUTH_SESSION_ID "$CONTROL_PLANE_AUTH_SESSION_ID"
set_env_file "$READINESS_ENV_FILE" CONTROL_PLANE_CREDENTIAL_INVENTORY_ATTESTED_AT "$CONTROL_PLANE_ATTESTED_AT"
set_env_file "$READINESS_ENV_FILE" CONTROL_PLANE_CREDENTIAL_ID "$CONTROL_PLANE_CREDENTIAL_ROW_ID"
set_env_file "$READINESS_ENV_FILE" CONTROL_PLANE_CREDENTIAL_REVOCATION_ATTESTED_AT "$CONTROL_PLANE_ATTESTED_AT"
set_env_file "$READINESS_ENV_FILE" CONTROL_PLANE_CREDENTIAL_REVOCATION_AUDIT_ID "$CONTROL_PLANE_REVOCATION_AUDIT_ID"
set_env_file "$READINESS_ENV_FILE" CONTROL_PLANE_SESSION_REVIEW_ATTESTED_AT "$CONTROL_PLANE_ATTESTED_AT"
set_env_file "$READINESS_ENV_FILE" CONTROL_PLANE_SESSION_REVIEW_VIEW_ID "$CONTROL_PLANE_SESSION_REVIEW_VIEW_ID"

jq -nc \
  --arg checkedAt "$CONTROL_PLANE_ATTESTED_AT" \
  --arg credentialId "$CONTROL_PLANE_CREDENTIAL_ROW_ID" \
  --arg revocationAuditId "$CONTROL_PLANE_REVOCATION_AUDIT_ID" \
  --arg sessionReviewViewId "$CONTROL_PLANE_SESSION_REVIEW_VIEW_ID" \
  --arg authSessionId "$CONTROL_PLANE_AUTH_SESSION_ID" \
  '{
    control_plane_attestation_status: "ok",
    checkedAt: $checkedAt,
    credentialId: $credentialId,
    revocationAuditId: $revocationAuditId,
    sessionReviewViewId: $sessionReviewViewId,
    authSessionId: $authSessionId
  }'
