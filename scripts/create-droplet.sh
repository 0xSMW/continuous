#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROJECT_NAME="${PROJECT_NAME:-continuous}"
PROJECT_DESCRIPTION="${PROJECT_DESCRIPTION:-Open source business platform}"
PROJECT_PURPOSE="${PROJECT_PURPOSE:-Web Application}"
PROJECT_ENVIRONMENT="${PROJECT_ENVIRONMENT:-Production}"
NAME="${NAME:-continuous-01}"
REGION="${REGION:-nyc3}"
SIZE="${SIZE:-s-2vcpu-4gb}"
IMAGE="${IMAGE:-ubuntu-24-04-x64}"
TAG="${TAG:-continuous}"
SSH_KEYS="${SSH_KEYS:-}"
SSH_CIDR="${SSH_CIDR:-}"
FIREWALL_NAME="${FIREWALL_NAME:-continuous-fw}"
ENABLE_MANAGED_BACKUPS="${ENABLE_MANAGED_BACKUPS:-true}"
VERIFY_MANAGED_BACKUPS="${VERIFY_MANAGED_BACKUPS:-$ENABLE_MANAGED_BACKUPS}"
BACKUP_POLICY_PLAN="${BACKUP_POLICY_PLAN:-}"
BACKUP_POLICY_HOUR="${BACKUP_POLICY_HOUR:-}"
BACKUP_POLICY_WEEKDAY="${BACKUP_POLICY_WEEKDAY:-}"

if ! command -v doctl >/dev/null 2>&1; then
  echo "doctl is required. Install it and run: doctl auth init" >&2
  exit 1
fi

if [ -z "$SSH_KEYS" ]; then
  SSH_KEYS="$(doctl compute ssh-key list --format FingerPrint --no-header | head -1 | tr -d '[:space:]')"
fi

if [ -z "$SSH_KEYS" ]; then
  echo "No DigitalOcean SSH key found. Set SSH_KEYS to a key id or fingerprint." >&2
  exit 1
fi

if [ -z "$SSH_CIDR" ]; then
  public_ip="$(curl -fsS https://ifconfig.me/ip 2>/dev/null || true)"
  if [ -n "$public_ip" ]; then
    SSH_CIDR="$public_ip/32"
  else
    echo "Could not detect operator public IP. Set SSH_CIDR explicitly." >&2
    exit 1
  fi
fi

enabled() {
  case "${1:-}" in
    true|1|yes|on) return 0 ;;
    false|0|no|off|"") return 1 ;;
    *)
      echo "Expected a boolean value, got: $1" >&2
      exit 1
      ;;
  esac
}

verify_managed_backups() {
  local droplet_id="$1"
  local features
  local policy_summary backup_enabled backup_plan window_hours retention_days
  local backup_images backup_count first_backup

  features="$(
    doctl compute droplet get "$droplet_id" --format ID,Name,Status,Features --no-header \
      | awk '{print $4}' \
      | tr -d '[:space:]'
  )"

  case ",$features," in
    *,backups,*)
      echo "DigitalOcean managed backups verified for droplet $droplet_id."
      ;;
    *)
      echo "DigitalOcean managed backups are not enabled for droplet $droplet_id." >&2
      echo "Droplet features: ${features:-none}" >&2
      exit 1
      ;;
  esac

  policy_summary="$(
    doctl compute droplet backup-policies get "$droplet_id" \
      --template '{{.BackupEnabled}} {{.BackupPolicy.Plan}} {{.BackupPolicy.WindowLengthHours}} {{.BackupPolicy.RetentionPeriodDays}}'
  )"
  read -r backup_enabled backup_plan window_hours retention_days <<<"$policy_summary"

  if [ "$backup_enabled" != "true" ]; then
    echo "DigitalOcean managed backup policy is not enabled for droplet $droplet_id." >&2
    echo "Backup policy enabled: ${backup_enabled:-unknown}" >&2
    exit 1
  fi

  echo "DigitalOcean managed backup policy verified for droplet $droplet_id: plan=${backup_plan:-unknown}, window=${window_hours:-unknown}h, retention=${retention_days:-unknown}d."

  backup_images="$(
    doctl compute droplet backups "$droplet_id" --format ID,Name,Type,Created --no-header
  )"
  backup_count="$(grep -cve '^[[:space:]]*$' <<<"$backup_images" || true)"

  if [ "$backup_count" -gt 0 ]; then
    first_backup="$(head -1 <<<"$backup_images")"
    echo "Available DigitalOcean backup images: $backup_count"
    echo "Latest DigitalOcean backup image: $first_backup"
  else
    echo "No DigitalOcean backup image is available yet; managed backup policy is active."
  fi
}

project_id="$(
  doctl projects list --format ID,Name --no-header \
    | awk -v name="$PROJECT_NAME" '$2 == name {print $1; exit}'
)"

if [ -z "$project_id" ]; then
  project_id="$(
    doctl projects create \
      --name "$PROJECT_NAME" \
      --description "$PROJECT_DESCRIPTION" \
      --purpose "$PROJECT_PURPOSE" \
      --environment "$PROJECT_ENVIRONMENT" \
      --format ID \
      --no-header
  )"
fi

doctl compute tag create "$TAG" >/dev/null 2>&1 || true

droplet_row="$(
  doctl compute droplet list --format ID,Name,PublicIPv4,Status --no-header \
    | awk -v name="$NAME" '$2 == name {print; exit}'
)"

if [ -z "$droplet_row" ]; then
  create_args=(
    "$NAME"
    --region "$REGION"
    --image "$IMAGE"
    --size "$SIZE"
    --ssh-keys "$SSH_KEYS"
    --tag-names "$TAG"
    --enable-monitoring
    --user-data-file infra/cloud-init.yaml
    --wait
  )

  if enabled "$ENABLE_MANAGED_BACKUPS"; then
    create_args+=(--enable-backups)

    if [ -n "$BACKUP_POLICY_PLAN" ]; then
      create_args+=(--backup-policy-plan "$BACKUP_POLICY_PLAN")
    fi

    if [ -n "$BACKUP_POLICY_HOUR" ]; then
      create_args+=(--backup-policy-hour "$BACKUP_POLICY_HOUR")
    fi

    if [ -n "$BACKUP_POLICY_WEEKDAY" ]; then
      create_args+=(--backup-policy-weekday "$BACKUP_POLICY_WEEKDAY")
    fi
  fi

  doctl compute droplet create "${create_args[@]}"

  droplet_row="$(
    doctl compute droplet list --format ID,Name,PublicIPv4,Status --no-header \
      | awk -v name="$NAME" '$2 == name {print; exit}'
  )"
else
  echo "Droplet already exists:"
  echo "$droplet_row"
fi

droplet_id="$(awk '{print $1}' <<<"$droplet_row")"

if enabled "$VERIFY_MANAGED_BACKUPS"; then
  verify_managed_backups "$droplet_id"
fi

doctl projects resources assign "$project_id" --resource "do:droplet:$droplet_id" >/dev/null

firewall_id="$(
  doctl compute firewall list --format ID,Name --no-header \
    | awk -v name="$FIREWALL_NAME" '$2 == name {print $1; exit}'
)"

ensure_firewall_rule() {
  local firewall_id="$1"
  local rule="$2"

  if doctl compute firewall get "$firewall_id" --format InboundRules --no-header \
    | grep -Fq "$rule"; then
    return
  fi

  doctl compute firewall add-rules "$firewall_id" --inbound-rules "$rule" >/dev/null
}

if [ -z "$firewall_id" ]; then
  doctl compute firewall create \
    --name "$FIREWALL_NAME" \
    --tag-names "$TAG" \
    --inbound-rules "protocol:tcp,ports:22,address:$SSH_CIDR protocol:tcp,ports:80,address:0.0.0.0/0 protocol:tcp,ports:443,address:0.0.0.0/0" \
    --outbound-rules "protocol:icmp,address:0.0.0.0/0 protocol:tcp,ports:0,address:0.0.0.0/0 protocol:udp,ports:0,address:0.0.0.0/0" \
    >/dev/null
else
  doctl compute firewall add-tags "$firewall_id" --tag-names "$TAG" >/dev/null 2>&1 || true
  ensure_firewall_rule "$firewall_id" "protocol:tcp,ports:22,address:$SSH_CIDR"
  ensure_firewall_rule "$firewall_id" "protocol:tcp,ports:80,address:0.0.0.0/0"
  ensure_firewall_rule "$firewall_id" "protocol:tcp,ports:443,address:0.0.0.0/0"
fi

echo "$droplet_row"
