# Implementation Notes

## 2026-05-19

### Decisions

| Decision | Rationale |
|---|---|
| Used Apache-2.0 | Suitable for an open source platform and includes a patent grant |
| Built a runnable Next/Postgres core service | The first blocker is platform substrate before worker layering |
| Used Drizzle and concrete Postgres tables from day one | The user chose real persistence instead of mocks |
| Chose DigitalOcean Droplet + Docker Compose | The user explicitly chose lower-level control over App Platform |
| Kept app, Postgres, and Caddy on one droplet for now | This is the fastest controlled production shape for a greenfield platform |
| Started with IP-only HTTP | The user owns `continuoushq.com` but DNS will be pointed later |
| Added a manual GitHub deploy workflow | CI should be automatic, but production deploys should be explicit while the platform is young |
| Standardized on Bun | Project instructions require Bun over npm/pnpm |

### Tradeoffs

| Tradeoff | Notes |
|---|---|
| Single droplet versus managed Postgres | Simpler and cheaper now; move Postgres out when customer data needs managed backup/isolation guarantees |
| Docker verification | Docker is not running locally on this Mac, so full container verification is happening on the DigitalOcean droplet |
| Domain TLS deferred | Caddy serves `http://:80` now; `configure-domain.sh` switches to hostnames and HTTPS after DNS |
| Bootstrap seed data | Seed records prove the substrate shape but are not customer fixtures |
| Deploy updates | The deploy script keeps Postgres and its volume in place, then recreates app/Caddy after migrations and seed data |
| Migration runner | Drizzle Kit's container migrator failed silently, so `db:migrate` uses a small Bun/Postgres runner that records Drizzle migration history and refuses partial baselines |

### Current State

The DigitalOcean stack is running on `45.55.53.92`. Continuous Core now has
persisted graph, task, capability, event, evidence, budget, adapter, and
generated UI primitives plus `/`, `/api/health`, and `/api/core`. Local
Node-side validation passes; the real Bun path is verified in the droplet
containers and GitHub CI.
