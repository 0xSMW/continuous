# Deployment Overview

Continuous is hosted on DigitalOcean and operated with `doctl`. The primary
deployment lane is a single Ubuntu Droplet running Docker Compose.

## Deployment Principles

| Principle | Requirement |
|---|---|
| Headless core first | Deploy the core API, worker runtime, task ledger, AI gateway, and evidence layer before broad UI surfaces |
| Typed actions only | Workers execute through capability grants, not raw credentials |
| Budget before inference | Expensive or risky model work reserves budget before execution |
| Evidence by default | External actions produce receipts, snapshots, traces, and reconciliation records |
| Human control for risk | Regulated work, money movement, sensitive data reveal, and policy changes require approval |
| Observable operations | Every workflow needs logs, traces, task state, usage cost, and evidence status |

## Target Environments

| Environment | Purpose |
|---|---|
| Local | Contributor development and workflow simulation |
| Staging | Connector tests, seed businesses, eval runs, migration rehearsals, and release verification |
| Production | Customer workloads with backups, alerts, least-privilege secrets, and release rollback |

## Current Droplet Shape

The concrete deployment scaffold is a single DigitalOcean Ubuntu droplet running
Docker Compose:

| Layer | DigitalOcean target |
|---|---|
| Compute | `scripts/create-droplet.sh` creates `continuous-01` by default in `nyc3` with size `s-2vcpu-4gb` |
| Project | `scripts/create-droplet.sh` creates or selects the `continuous` DigitalOcean project |
| Firewall | `scripts/create-droplet.sh` creates a `continuous-fw` firewall for SSH from the current trusted IP plus public HTTP/HTTPS |
| Provisioning | `infra/cloud-init.yaml` installs Docker, Docker Compose plugin, rsync, UFW, swap, and `/opt/continuous` |
| App | `Dockerfile` builds the Next.js standalone app image |
| Database | `docker-compose.yml` runs private Postgres 17 with a persistent Docker volume |
| Proxy | `Caddyfile` runs Caddy for HTTP/HTTPS reverse proxy and TLS |
| Deploy | `scripts/deploy.sh` rsyncs the repo to `/opt/continuous`, runs `docker compose up -d --build`, then runs migrations and seed data |
| Domain | `scripts/configure-domain.sh` updates `SITE_HOSTS` and recreates Caddy |

This is a good first path for speed and simple operations. Move database or
worker workloads to managed services when customer data, backups, isolation, or
scale require it.

## Manual GitHub Deploy

`.github/workflows/deploy.yml` is a manual workflow for the droplet path. It
requires `DEPLOY_SSH_KEY`, a `host` input, and optionally `site_hosts`. It uses
the same `scripts/deploy.sh` path as local deploys.

## `doctl` Operations

Use `doctl` for DigitalOcean account and resource operations.

Current droplet creation:

```sh
SSH_KEYS=your-do-ssh-key-id-or-fingerprint ./scripts/create-droplet.sh
```

Current deploy by IP:

```sh
HOST=your-droplet-ip ./scripts/deploy.sh
```

Current DNS records for `continuoushq.com`:

```sh
doctl compute domain records create continuoushq.com --record-type A --record-name @ --record-data your-droplet-ip
doctl compute domain records create continuoushq.com --record-type CNAME --record-name www --record-data continuoushq.com.
```

Current domain/TLS switch:

```sh
HOST=your-droplet-ip ACME_EMAIL=admin@continuoushq.com ./scripts/configure-domain.sh
```

Minimum command coverage still needed:

| Operation | Required coverage |
|---|---|
| Auth | Account login and current account verification |
| Project | Create or select the Continuous project |
| Database | Provision, inspect, back up, restore, and rotate credentials |
| App services | Inspect, roll back, and stream logs for the droplet Compose services |
| Secrets | Set, rotate, and audit app secrets |
| Domains | Attach domains and verify TLS |
| Observability | Inspect logs, metrics, alerts, and incidents |

## Release Gates

Before the first production deploy, the repo needs:

| Gate | Required proof |
|---|---|
| Environment schema | `.env.example`, `infra/env.example`, secrets, and provider credentials documented |
| Migration path | Database create, migrate, rollback, backup, and restore path tested |
| Health checks | API, worker, AI gateway, queue, database, and adapter health endpoints |
| Capability policy | Risk levels and approval rules enforced outside prompts |
| Budget controls | Reservation, charge, hard limit, overage, and emergency policy tested |
| Evidence capture | Receipts and snapshots stored for every external action |
| Eval harness | Worker output, cost, latency, correction, and safety checks automated |
| Connector safety | Retries, idempotency, scoped credentials, webhooks, and reconciliation tested |
| Observability | Logs, metrics, traces, alerts, and incident process available |
| Rollback | Service rollback, data restore, and migration rollback rehearsed in staging |

## First Rollout Sequence

1. Deploy the current app and Postgres path to the `continuous-01` droplet.
2. Verify `/`, `/api/health`, and `/api/core`.
3. Prove backup, restore, and service rollback.
4. Add durable worker runtime with the Revenue Worker disabled by default.
5. Connect one email path, one calendar path, one payment path, and one accounting or spreadsheet path in staging.
6. Run historical lead simulations and eval scoring.
7. Promote to production only after evidence completeness, budget controls, and rollback are proven.

## Open Deployment Questions

| Question | Why it matters |
|---|---|
| Queue choice | Determines worker concurrency, retries, and local parity |
| Evidence retention policy | Affects storage cost, privacy, audit support, and export design |
| Secrets boundary | Decides how customer provider credentials are scoped and rotated |
| Tenant isolation model | Drives database, storage, logging, and support architecture |
