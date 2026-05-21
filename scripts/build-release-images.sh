#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_IMAGE="${APP_IMAGE:-continuous-app}"
APP_TAG="${APP_TAG:-sha-$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
APP_REVISION="${APP_REVISION:-$(git rev-parse HEAD 2>/dev/null || printf 'unknown')}"
APP_CREATED="${APP_CREATED:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
APP_SOURCE="${APP_SOURCE:-https://github.com/0xSMW/continuous}"
OUTPUT="${RELEASE_IMAGE_ARCHIVE:-release/continuous-images-$APP_TAG.tar.gz}"

if [[ ! "$APP_IMAGE" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "APP_IMAGE may only contain letters, numbers, dot, underscore, slash, or dash." >&2
  exit 1
fi

if [[ ! "$APP_TAG" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "APP_TAG may only contain letters, numbers, dot, underscore, or dash." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build Continuous release images." >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

mkdir -p "$(dirname "$OUTPUT")"
export DOCKER_BUILDKIT=1

docker build \
  --target runner \
  --build-arg "APP_REVISION=$APP_REVISION" \
  --build-arg "APP_CREATED=$APP_CREATED" \
  --build-arg "APP_SOURCE=$APP_SOURCE" \
  -t "$APP_IMAGE:$APP_TAG" \
  .

docker build \
  --target migrate \
  --build-arg "APP_REVISION=$APP_REVISION" \
  --build-arg "APP_CREATED=$APP_CREATED" \
  --build-arg "APP_SOURCE=$APP_SOURCE" \
  -t "$APP_IMAGE:$APP_TAG-migrate" \
  -t "$APP_IMAGE:$APP_TAG-scheduler" \
  .

docker save \
  "$APP_IMAGE:$APP_TAG" \
  "$APP_IMAGE:$APP_TAG-migrate" \
  "$APP_IMAGE:$APP_TAG-scheduler" \
  | gzip -c > "$OUTPUT"

archive_sha="$(sha256_file "$OUTPUT")"
printf '%s  %s\n' "$archive_sha" "$(basename "$OUTPUT")" > "$OUTPUT.sha256"

app_id="$(docker image inspect --format '{{.Id}}' "$APP_IMAGE:$APP_TAG")"
migrate_id="$(docker image inspect --format '{{.Id}}' "$APP_IMAGE:$APP_TAG-migrate")"
scheduler_id="$(docker image inspect --format '{{.Id}}' "$APP_IMAGE:$APP_TAG-scheduler")"

cat > "$OUTPUT.manifest.json" <<JSON
{
  "appImage": "$APP_IMAGE:$APP_TAG",
  "migrateImage": "$APP_IMAGE:$APP_TAG-migrate",
  "schedulerImage": "$APP_IMAGE:$APP_TAG-scheduler",
  "appImageId": "$app_id",
  "migrateImageId": "$migrate_id",
  "schedulerImageId": "$scheduler_id",
  "archive": "$OUTPUT",
  "archiveSha256": "$archive_sha",
  "revision": "$APP_REVISION",
  "created": "$APP_CREATED",
  "source": "$APP_SOURCE"
}
JSON

printf 'Built Continuous release images:\n'
printf '  app:       %s:%s (%s)\n' "$APP_IMAGE" "$APP_TAG" "$app_id"
printf '  migrate:   %s:%s-migrate (%s)\n' "$APP_IMAGE" "$APP_TAG" "$migrate_id"
printf '  scheduler: %s:%s-scheduler (%s)\n' "$APP_IMAGE" "$APP_TAG" "$scheduler_id"
printf '  archive:   %s\n' "$OUTPUT"
printf '  sha256:    %s\n' "$archive_sha"
