# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@11

FROM base AS deps
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./
RUN corepack enable \
    && if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
       elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
       elif [ -f package-lock.json ]; then npm ci; \
       else npm install; fi

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN corepack enable \
    && if [ -f pnpm-lock.yaml ]; then pnpm build; \
       elif [ -f yarn.lock ]; then yarn build; \
       else npm run build; fi

FROM base AS migrate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npm", "run", "db:migrate"]

FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
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
