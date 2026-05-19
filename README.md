# Continuous

Continuous is an open source business platform for SMBs to hire, manage, govern,
budget, evaluate, and coordinate human, AI, and robot workers.

The first runtime slice is **Continuous Core**: a persisted headless operating
layer for entity, workforce, payroll, filings, compliance, payments, AI
operations, generated UI, and evidence. Revenue workflows remain the first
customer-facing worker demo, but they sit on top of this broader core.

## Stack

- Next.js 16 + React 19 + TypeScript
- Postgres + Drizzle ORM/migrations
- Docker Compose with Next.js, Postgres, and Caddy
- GitHub Actions CI for lint, typecheck, tests, and build
- DigitalOcean droplet deployment through `doctl`, SSH, and Compose

## Local Development

```sh
bun install
bun run check
```

If Docker is running locally:

```sh
docker compose up -d db
bun run db:migrate
bun run db:seed
bun run dev
```

Then open `http://localhost:3000`.

## Core APIs

- `/api/health` reports Postgres-backed readiness checks.
- `/api/core` returns persisted core counts, active tasks, and recent events for tokened operators.
- `/api/revenue-worker` returns the persisted Revenue Worker snapshot for tokened operators.
- `/api/revenue-worker/run` is a disabled-by-default guarded `POST` run path.

## Docs

- [Core platform](docs/core-platform.md)
- [Open workflows](docs/workflows.md)
- [Agent build path](docs/agent-build-path.md)
- [Revenue Worker expansion](docs/revenue-worker-expansion.md)
- [Worker expansion map](docs/worker-expansion.md)
- [Local development](docs/local-development.md)
- [DigitalOcean deployment](docs/deployment.md)
- [Infrastructure notes](infra/README.md)

## Deployment

The production host is a DigitalOcean droplet. Deploy to the configured domains:

```sh
./scripts/create-droplet.sh
HOST=45.55.53.92 ./scripts/deploy.sh
```

After DNS changes, refresh the Caddy site hosts without a full app deploy:

```sh
HOST=45.55.53.92 ./scripts/configure-domain.sh
```

Caddy issues and renews the HTTPS certificates automatically for
`continuoushq.com` and `getcontinuous.app`.

## License

Apache-2.0. See [LICENSE](LICENSE).
