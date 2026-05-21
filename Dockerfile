# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14
ARG NODE_VERSION=22
ARG APP_REVISION=unknown
ARG APP_CREATED=unknown
ARG APP_SOURCE=https://github.com/0xSMW/continuous

FROM oven/bun:${BUN_VERSION}-debian AS base
ARG APP_REVISION
ARG APP_CREATED
ARG APP_SOURCE
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
LABEL org.opencontainers.image.title="Continuous" \
    org.opencontainers.image.description="Open source worker platform core for SMB operating flows." \
    org.opencontainers.image.source="${APP_SOURCE}" \
    org.opencontainers.image.revision="${APP_REVISION}" \
    org.opencontainers.image.created="${APP_CREATED}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN bun run build

FROM base AS migrate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["bun", "run", "db:migrate"]

FROM node:${NODE_VERSION}-bookworm-slim AS runner
ARG APP_REVISION
ARG APP_CREATED
ARG APP_SOURCE
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
LABEL org.opencontainers.image.title="Continuous" \
    org.opencontainers.image.description="Open source worker platform core for SMB operating flows." \
    org.opencontainers.image.source="${APP_SOURCE}" \
    org.opencontainers.image.revision="${APP_REVISION}" \
    org.opencontainers.image.created="${APP_CREATED}"
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs \
    && mkdir -p /app \
    && chown nextjs:nodejs /app

RUN --mount=from=build,source=/app,target=/src <<'EOF'
set -eux

if [ ! -d /src/.next ]; then
  echo "Missing Next.js build output at .next" >&2
  exit 1
fi

if [ -d /src/.next/standalone ]; then
  cp -a /src/.next/standalone/. /app/
  mkdir -p /app/.next
  cp -a /src/.next/static /app/.next/static
  if [ -d /src/public ]; then cp -a /src/public /app/public; fi
else
  cp -a /src/package.json /app/package.json
  cp -a /src/node_modules /app/node_modules
  cp -a /src/.next /app/.next
  if [ -d /src/public ]; then cp -a /src/public /app/public; fi
  find /src -maxdepth 1 -name 'next.config.*' -exec cp -a {} /app/ \;
fi

chown -R nextjs:nodejs /app
EOF

USER nextjs
EXPOSE 3000
CMD ["sh", "-c", "if [ -f server.js ]; then node server.js; else node node_modules/next/dist/bin/next start; fi"]
