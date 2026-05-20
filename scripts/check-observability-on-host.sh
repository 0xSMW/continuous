#!/usr/bin/env bash
set -u -o pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
SITE_HOSTS="${SITE_HOSTS:-}"
MAX_DISK_PERCENT="${MAX_DISK_PERCENT:-85}"
CERT_MIN_DAYS="${CERT_MIN_DAYS:-14}"
REQUIRE_CADDY_ACCESS_LOG="${REQUIRE_CADDY_ACCESS_LOG:-true}"
REQUIRE_BACKUP_FRESH="${REQUIRE_BACKUP_FRESH:-false}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-$APP_DIR/backups/postgres}"
REQUIRE_CHECKSUM="${REQUIRE_CHECKSUM:-true}"
CHECK_SYSTEMD_FAILED="${CHECK_SYSTEMD_FAILED:-false}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
ALERT_WEBHOOK_TIMEOUT_SECONDS="${ALERT_WEBHOOK_TIMEOUT_SECONDS:-8}"
CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

failures=()

record_failure() {
  failures+=("$1")
  printf 'FAIL %s\n' "$1" >&2
}

record_ok() {
  printf 'OK %s\n' "$1"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

send_alert() {
  if [ -z "$ALERT_WEBHOOK_URL" ] || [ "${#failures[@]}" -eq 0 ]; then
    return
  fi

  detail="$(
    printf '%s; ' "${failures[@]}" \
      | sed 's/; $//'
  )"
  payload="$(
    printf '{"service":"continuous","status":"failed","host":"%s","checkedAt":"%s","details":"%s"}' \
      "$(json_escape "$(hostname -f 2>/dev/null || hostname)")" \
      "$CHECKED_AT" \
      "$(json_escape "$detail")"
  )"

  curl -fsS \
    --max-time "$ALERT_WEBHOOK_TIMEOUT_SECONDS" \
    -H "content-type: application/json" \
    -d "$payload" \
    "$ALERT_WEBHOOK_URL" >/dev/null || true
}

trim() {
  sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

load_site_hosts() {
  if [ -n "$SITE_HOSTS" ]; then
    printf '%s' "$SITE_HOSTS"
    return
  fi

  if [ -f "$APP_DIR/.env" ]; then
    grep '^SITE_HOSTS=' "$APP_DIR/.env" | tail -1 | cut -d= -f2-
  fi
}

cd "$APP_DIR" 2>/dev/null || {
  record_failure "app_dir_missing:$APP_DIR"
  send_alert
  exit 1
}

if [ ! -f .env ]; then
  record_failure "env_missing:$APP_DIR/.env"
else
  record_ok "env_present"
fi

site_hosts_raw="$(load_site_hosts)"
IFS=',' read -r -a site_hosts <<< "$site_hosts_raw"
normalized_hosts=()

for host in "${site_hosts[@]}"; do
  clean_host="$(printf '%s' "$host" | trim)"
  clean_host="${clean_host#http://}"
  clean_host="${clean_host#https://}"

  if [ -n "$clean_host" ]; then
    normalized_hosts+=("$clean_host")
  fi
done

if [ "${#normalized_hosts[@]}" -eq 0 ]; then
  record_failure "site_hosts_missing"
fi

for service in db app caddy; do
  if docker compose ps --status running "$service" | grep -q "$service"; then
    record_ok "service_running:$service"
  else
    record_failure "service_not_running:$service"
  fi
done

if grep -q '^WORKER_SCHEDULER_ENABLED=true$' .env 2>/dev/null; then
  if docker compose --profile scheduler ps --status running worker-scheduler | grep -q worker-scheduler; then
    record_ok "service_running:worker-scheduler"
  else
    record_failure "service_not_running:worker-scheduler"
  fi
fi

disk_percent="$(
  df -P "$APP_DIR" 2>/dev/null \
    | awk 'NR == 2 {gsub(/%/, "", $5); print $5}'
)"

if [[ "$disk_percent" =~ ^[0-9]+$ ]]; then
  if [ "$disk_percent" -le "$MAX_DISK_PERCENT" ]; then
    record_ok "disk_percent:$disk_percent"
  else
    record_failure "disk_percent_high:$disk_percent"
  fi
else
  record_failure "disk_percent_unavailable"
fi

cert_check_seconds=$((CERT_MIN_DAYS * 86400))

for host in "${normalized_hosts[@]}"; do
  health_url="https://$host/api/health"
  health_response="$(curl -fsS --max-time 12 --resolve "$host:443:127.0.0.1" "$health_url" 2>/dev/null)"

  if printf '%s' "$health_response" | grep -q '"status":"ok"'; then
    record_ok "health_ok:$host"
  else
    record_failure "health_failed:$host"
  fi

  if openssl s_client -connect "127.0.0.1:443" -servername "$host" </dev/null 2>/dev/null \
    | openssl x509 -checkend "$cert_check_seconds" -noout >/dev/null 2>&1; then
    record_ok "cert_valid:${host}:${CERT_MIN_DAYS}d"
  else
    record_failure "cert_expiring_or_invalid:$host"
  fi
done

if [ "$REQUIRE_CADDY_ACCESS_LOG" = "true" ]; then
  if [ -s "$APP_DIR/logs/caddy/access.log" ]; then
    record_ok "caddy_access_log_present"
  elif docker compose logs --tail=400 caddy 2>/dev/null | grep -q '"logger":"http.log.access"'; then
    record_ok "caddy_access_log_present:docker_stdout"
  else
    record_failure "caddy_access_log_missing_or_empty"
  fi
fi

if [ "$REQUIRE_BACKUP_FRESH" = "true" ]; then
  latest_backup="$(find "$REMOTE_BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -print0 2>/dev/null | xargs -0 ls -1t 2>/dev/null | head -1 || true)"

  if [ -z "$latest_backup" ]; then
    record_failure "backup_missing:$REMOTE_BACKUP_DIR"
  else
    if [ "$REQUIRE_CHECKSUM" = "true" ]; then
      if [ ! -f "$latest_backup.sha256" ]; then
        record_failure "backup_checksum_missing:$latest_backup"
      else
        expected="$(awk '{print $1; exit}' "$latest_backup.sha256")"
        actual="$(sha256sum "$latest_backup" | awk '{print $1}')"

        if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
          record_ok "backup_checksum_valid"
        else
          record_failure "backup_checksum_mismatch:$latest_backup"
        fi
      fi
    fi

    backup_mtime="$(stat -c '%Y' "$latest_backup" 2>/dev/null || printf '0')"
    now="$(date -u +%s)"
    backup_age_seconds=$((now - backup_mtime))
    max_age_seconds=$((BACKUP_MAX_AGE_HOURS * 3600))

    if [ "$backup_age_seconds" -le "$max_age_seconds" ]; then
      record_ok "backup_fresh:${backup_age_seconds}s"
    else
      record_failure "backup_too_old:${backup_age_seconds}s"
    fi
  fi
fi

if [ "$CHECK_SYSTEMD_FAILED" = "true" ]; then
  failed_units="$(systemctl --failed --no-legend --plain 2>/dev/null || true)"

  if [ -z "$failed_units" ]; then
    record_ok "systemd_failed_units:none"
  else
    record_failure "systemd_failed_units:$(printf '%s' "$failed_units" | awk '{print $1}' | paste -sd, -)"
  fi
fi

if [ "${#failures[@]}" -gt 0 ]; then
  send_alert
  printf 'continuous_observability_status=failed\n' >&2
  printf 'checked_at=%s\n' "$CHECKED_AT" >&2
  exit 1
fi

printf 'continuous_observability_status=ok\n'
printf 'checked_at=%s\n' "$CHECKED_AT"
