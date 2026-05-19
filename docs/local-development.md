# Local Development

## Requirements

- Node.js 22+
- Bun 1.3+
- Docker, when testing Postgres and Compose locally
- `doctl`, when operating DigitalOcean resources

## Commands

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
```

## Database

Create a local `.env` from `.env.example`, then fill `DATABASE_URL` and
`POSTGRES_PASSWORD` with local-only values. Keep `.env` untracked.

With Docker running:

```sh
docker compose up -d db
bun run db:migrate
bun run db:seed
```

`db:seed` is idempotent and loads a bootstrap service-SMB lead-to-cash slice:
tenant, owner, Revenue Operations Worker, customer, lead, quote, job, invoice,
payment, capabilities, task, event, evidence, budget records, adapter record,
and generated UI contract.

## Run

```sh
bun run dev
```

Open `http://localhost:3000`, `/api/health`, and `/api/core`.

The repo also includes `.mcp.json` for the Next.js MCP bridge. With `bun run dev`
running, compatible coding agents can inspect routes, runtime errors, metadata,
and logs through `next-devtools-mcp`.

## Revenue Worker

The seed data includes the Continuous Revenue Worker for a service-SMB
lead-to-cash slice. Detailed snapshots are operator-only and require the worker
token:

```sh
read -rsp "Worker token: " REVENUE_WORKER_RUN_TOKEN
export REVENUE_WORKER_RUN_TOKEN
bun run dev
curl http://localhost:3000/api/revenue-worker \
  -H "authorization: Bearer $REVENUE_WORKER_RUN_TOKEN"
```

The run API is a guarded side-effecting `POST` and is disabled by default. For
local-only testing, start the app with:

```sh
read -rsp "Worker token: " REVENUE_WORKER_RUN_TOKEN
export REVENUE_WORKER_RUN_ENABLED=true
export REVENUE_WORKER_RUN_TOKEN
bun run dev
curl -X POST http://localhost:3000/api/revenue-worker/run \
  -H "authorization: Bearer $REVENUE_WORKER_RUN_TOKEN" \
  -H 'idempotency-key: local-revenue-run-001'
```

The same persisted loop can run without exposing HTTP:

```sh
IDEMPOTENCY_KEY=local-revenue-run-002 bun run worker:revenue
```

## Notes

The app is intentionally server-rendered and database-backed. If Postgres is
down, the UI still renders a degraded health state instead of hiding the
failure.
