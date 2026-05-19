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
approval request, audit event, and generated UI contract.

## Run

```sh
bun run dev
```

Open `http://localhost:3000` and `/api/health`. `/api/core` is an
operator-only summary and uses the same bearer token as the canonical `/worker`
control plane.

The repo also includes `.mcp.json` for the Next.js MCP bridge. With `bun run dev`
running, compatible coding agents can inspect routes, runtime errors, metadata,
and logs through `next-devtools-mcp`. The installed Codex app-server CLI exposes
protocol tooling for future repo-owned worker controls; inspect it with
`bun run app-server:help` when worker build tooling needs it.

## Revenue Worker

The seed data includes the Continuous Revenue Worker for a service-SMB
lead-to-cash slice. Detailed snapshots are operator-only and require the worker
token:

```sh
read -rsp "Worker token: " REVENUE_WORKER_RUN_TOKEN
export REVENUE_WORKER_RUN_TOKEN
bun run dev
curl "http://localhost:3000/worker?view=snapshot&role=revenue_operations" \
  -H "authorization: Bearer $REVENUE_WORKER_RUN_TOKEN"
```

The run API is a guarded side-effecting `POST` and is disabled by default. For
local-only testing, start the app with:

```sh
read -rsp "Worker token: " REVENUE_WORKER_RUN_TOKEN
export REVENUE_WORKER_RUN_ENABLED=true
export REVENUE_WORKER_RUN_TOKEN
bun run dev
curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $REVENUE_WORKER_RUN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "command": "run",
    "worker": {"role": "revenue_operations"},
    "idempotencyKey": "local-revenue-run-001",
    "config": {}
  }'
```

Runs are bound to `REVENUE_WORKER_OPERATOR_EMAIL`, which defaults to the seeded
`owner@continuoushq.com` user. A successful run records an approval request and
audit trail while keeping external send and money movement blocked.

The same persisted loop can run without exposing HTTP:

```sh
IDEMPOTENCY_KEY=local-revenue-run-002 bun run worker:revenue
```

Agent-facing local automation can use the repo-owned worker toolbox:

```sh
bun run worker:tool schema
bun run worker:tool worker.snapshot --payload='{"worker":{"role":"revenue_operations"}}'
```

List and decide approvals with the same bearer token:

```sh
curl "http://localhost:3000/worker?view=approvals&role=revenue_operations" \
  -H "authorization: Bearer $REVENUE_WORKER_RUN_TOKEN"

curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $REVENUE_WORKER_RUN_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"command\": \"approval.decide\",
    \"worker\": {\"role\": \"revenue_operations\"},
    \"config\": {\"approvalId\": \"$APPROVAL_ID\", \"action\": \"approved\"}
  }"
```

The older `/api/revenue-worker*` paths are compatibility wrappers for the first
worker. New worker families should target `/worker` with role and config in the
request payload.

## Notes

The app is intentionally server-rendered and database-backed. If Postgres is
down, the UI still renders a degraded health state instead of hiding the
failure.
