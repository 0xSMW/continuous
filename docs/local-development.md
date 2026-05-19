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

Use the default local URL:

```sh
DATABASE_URL=postgres://continuous:continuous@localhost:5432/continuous
```

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

## Notes

The app is intentionally server-rendered and database-backed. If Postgres is
down, the UI still renders a degraded health state instead of hiding the
failure.
