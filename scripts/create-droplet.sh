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
  doctl compute droplet create "$NAME" \
    --region "$REGION" \
    --image "$IMAGE" \
    --size "$SIZE" \
    --ssh-keys "$SSH_KEYS" \
    --tag-names "$TAG" \
    --enable-monitoring \
    --user-data-file infra/cloud-init.yaml \
    --wait

  droplet_row="$(
    doctl compute droplet list --format ID,Name,PublicIPv4,Status --no-header \
      | awk -v name="$NAME" '$2 == name {print; exit}'
  )"
else
  echo "Droplet already exists:"
  echo "$droplet_row"
fi

droplet_id="$(awk '{print $1}' <<<"$droplet_row")"
doctl projects resources assign "$project_id" --resource "do:droplet:$droplet_id" >/dev/null

firewall_id="$(
  doctl compute firewall list --format ID,Name --no-header \
    | awk -v name="$FIREWALL_NAME" '$2 == name {print $1; exit}'
)"

if [ -z "$firewall_id" ]; then
  doctl compute firewall create \
    --name "$FIREWALL_NAME" \
    --tag-names "$TAG" \
    --inbound-rules "protocol:tcp,ports:22,address:$SSH_CIDR protocol:tcp,ports:80,address:0.0.0.0/0 protocol:tcp,ports:443,address:0.0.0.0/0" \
    --outbound-rules "protocol:icmp,address:0.0.0.0/0 protocol:tcp,ports:0,address:0.0.0.0/0 protocol:udp,ports:0,address:0.0.0.0/0" \
    >/dev/null
fi

echo "$droplet_row"
