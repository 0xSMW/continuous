# Continuous

Continuous is an open source business platform for SMBs to hire, manage, govern,
budget, evaluate, and coordinate human, AI, and robot workers.

The strategy is to build a headless worker platform, not a chat app or a fixed
SaaS dashboard. Continuous Core makes a business legible through a business
graph, task ledger, workflow engine, capability registry, AI gateway, adapter
runtime, generated UI, and evidence layer. Continuous Workers then use that
substrate to own measurable operating outcomes.

The first product wedge is the Revenue Operations Worker for service SMBs:
missed leads, slow quotes, scheduling, deposits, invoices, collections, reviews,
and daily owner briefs.

## Status

This repository is greenfield and already has an early platform scaffold.
`STRATEGY.md` is the source strategy. The current runtime shape is a
Next.js/TypeScript app with a static Continuous Core admin surface, health/core
API routes, a Drizzle/Postgres schema, npm scripts, Docker Compose packaging,
and DigitalOcean deployment scaffolding.

## Repository Map

| Path | Purpose |
|---|---|
| `STRATEGY.md` | Full product, market, architecture, and roadmap strategy |
| `app/` | Early Next.js app and API routes |
| `src/` | Early core model, health, database, and summary code |
| `docs/core-platform.md` | Core platform setup and bootstrap sequence |
| `docs/local-development.md` | Local development workflow for the current repo state |
| `docs/deployment.md` | DigitalOcean deployment overview and release gates |
| `infra/` | DigitalOcean droplet setup notes and cloud-init |
| `scripts/` | DigitalOcean deploy helper scripts |
| `implementation.md` | Running notes on decisions, tradeoffs, and open context |
| `LICENSE` | Apache License 2.0 |

## Core Platform

Continuous Core is the reusable substrate shared by every worker:

| Component | Role |
|---|---|
| Business graph | Canonical memory for customers, jobs, money, workers, systems, obligations, and decisions |
| Event log | Durable record of what happened and what can be replayed |
| Task ledger | Accountable work queue for humans and workers |
| Workflow engine | Multi-step work across people, workers, approvals, and external systems |
| Rule engine | Policy, pricing, risk, vertical rules, and compliance logic |
| Capability registry | Typed actions workers can invoke safely |
| AI gateway | Model routing, budget controls, usage ledger, redaction, and evals |
| Adapter runtime | Connectors into systems of action such as email, calendar, accounting, payments, CRM, and forms |
| Generated UI | Approval cards, briefs, task queues, exception views, dashboards, and evidence packets |
| Evidence layer | Receipts, snapshots, traces, approvals, audit history, and exports |

See [docs/core-platform.md](docs/core-platform.md).

## Local Development

The app uses Node.js 22+, npm 11+, Next.js, TypeScript, Drizzle, and Postgres.
Start with the shared-work check:

```sh
git status --short
```

Then install and run:

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`, `http://localhost:3000/api/health`, and
`http://localhost:3000/api/core`.

See [docs/local-development.md](docs/local-development.md) for checks and
database notes.

## Deployment

Continuous runs on DigitalOcean through the Droplet/Docker Compose path. The
current deployment creates a `continuous` project, a `continuous-01` Ubuntu
droplet, a firewall, and a Compose stack with the app, Postgres, and Caddy.

See [docs/deployment.md](docs/deployment.md).

## License

Continuous is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
