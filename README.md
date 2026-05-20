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
- `/core` returns persisted core counts, active tasks, and recent events for tokened operators;
  `POST /core` accepts structured core commands: `task.create`,
  `task.transition`, `object.upsert`, `adapter.upsert`,
  `connection.upsert`, `connection.health.record`, `object.link`,
  `event.ingest`, `evidence.attach`, `document.create`, `packet.prepare`,
  `document.packet.prepare`, `decision.record`,
  `approval.request`, `adapter.intent.record`, `rule.change.record`,
  `capability.grant`, `budget.reserve`, `budget.charge`, `budget.release`,
  `view.publish`, `customer_signal.record`, `payroll.preview.record`, and
  `payroll.preview.packet.prepare`. Core mutation requests accept only
  `command`, `core`, `idempotencyKey`, and `config` as top-level fields.
- `/approval` is the shared approval control-plane API. Use
  `GET /approval?view=inbox&tenantSlug=continuous-demo&subject=all`, or
  `POST /approval` with `command=approval.decide`, structured `approval`, and
  `config` fields.
- `/worker` is the canonical worker control-plane API. Use
  `GET /worker?view=snapshot&role=revenue_operations` or
  `GET /worker?view=approvals&role=revenue_operations`; use `POST /worker` with
  explicit `worker.role`, `command`, `idempotencyKey` when required, and
  `config` payloads for side-effecting worker commands. Revenue operations runs
  accept only `command`, `worker`, `idempotencyKey`, and `config` as top-level
  command fields; role and tenant selectors live under `worker`, and operation
  inputs such as source records, approval ids, retry limits, or lead payloads
  live under `config`. Revenue operations runs can first call
  `command=lead.read` with `config.source` and
  `config.records[]` to persist Core lead source snapshots, then call
  `command=lead.classify`, `command=response.draft`, or the full `command=run`
  with the returned `config.intake` selector. The split classify and draft
  commands write worker run, inference, usage, event, evidence, and audit proof
  while external send remains blocked. Internal workflow handlers can still use
  exact Core row ids; `config.leadPacket` remains a direct operator/test
  fallback. The route validates roles, commands, idempotency, tenant
  requirements, and external-execution posture through the worker command
  registry.
- Dispatch schedule proposals use the same shape:
  `POST /worker` with `worker.role=dispatch_operations`,
  `command=schedule.propose`, handoff ids in `config.sourceRefs`, and schedule
  requirements in `config.constraints`; the first slice writes only dry-run
  calendar receipts and approval records.
- `/workflow` is the canonical workflow control-plane API. Use `GET /workflow`
  for definitions/runs/steps, `GET /workflow?view=approvals` for workflow
  approvals, and `POST /workflow` with `command=start`, `command=transition`,
  `command=steps.execute`, or `command=approval.decide`. Queued workflow
  execution can now prepare durable Core packets from packet-backed step kinds
  without adding packet-specific business-process routes.
- `worker-scheduler` is the internal production drain for queued platform work.
  It posts the same `/workflow` `steps.execute` envelope, polls active lead
  source connections with `/worker command=lead.read`, hands returned selectors
  to `/worker command=run`, then drains `/worker` adapter retry/reconcile
  envelopes on a cadence; it does not introduce worker-family URLs or enable
  external execution.
Worker-specific HTTP routes and local mutation shortcuts are intentionally
absent; new worker families extend `/worker` and `worker:tool` by registering
commands and structured payload fields. The HTTP, app-server, and local worker
command surfaces reject stray top-level operation fields so worker-specific
inputs stay under `config`.

## Docs

- [Core platform](docs/core-platform.md)
- [Open workflows](docs/workflows.md)
- [Agent build path](docs/agent-build-path.md)
- [Revenue Operations Worker expansion](docs/revenue-operations-worker-expansion.md)
- [Revenue Operations Worker V1 contract](docs/revenue-operations-worker-v1-contract.md)
- [Worker expansion map](docs/worker-expansion.md)
- [Worker execution roadmap](docs/worker-roadmap.md)
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
HOST=45.55.53.92 SITE_HOSTS="continuoushq.com, getcontinuous.app" ./scripts/configure-domain.sh
```

Caddy issues and renews the HTTPS certificates automatically for
`continuoushq.com` and `getcontinuous.app`.

Before treating the droplet as customer-data ready, run the strict production
readiness gate after backup scheduling, alerting, recovery-drill evidence,
token rotation, and non-root host access are in place:

```sh
HOST=45.55.53.92 bun run ops:production-readiness-check
```

## License

Apache-2.0. See [LICENSE](LICENSE).
