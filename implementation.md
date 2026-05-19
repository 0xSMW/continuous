# Implementation Notes

## 2026-05-19

### Decisions

| Decision | Rationale |
|---|---|
| Added Apache License 2.0 | The repo had no existing license file and project instructions said to use Apache-2.0 unless contradicted |
| Updated docs around the active scaffold | Source, package, Docker, infra, and CI files appeared during this pass from concurrent work; docs now reference them without modifying them |
| Made `STRATEGY.md` the strategy source of truth | The strategy is complete and detailed; new docs should summarize and operationalize it rather than fork it |
| Documented DigitalOcean as the deployment target | Project instructions say infrastructure will be hosted on DigitalOcean and operated with `doctl` |
| Chose Droplet/Docker Compose as the deployment lane | The owner explicitly chose lower-level control over App Platform |
| Chose direct documentation filenames | `core-platform.md`, `local-development.md`, and `deployment.md` are simpler than numbered or verbose names for the current repo size |

### Tradeoffs

| Tradeoff | Notes |
|---|---|
| Shared scaffolding versus owned docs | I read source/package/deploy/CI files to keep docs accurate but did not edit them |
| Droplet versus managed services | The first deploy keeps app and Postgres on one droplet for speed and control; managed Postgres should be reconsidered once customer data requires stronger backup/isolation operations |
| Full docs tree versus focused seed docs | The strategy calls for a large docs tree, but this pass creates only the setup docs requested and leaves the larger tree for follow-up work |
| Detailed schemas versus platform setup | The core platform doc names initial objects and fields but does not define full schemas yet |

### Follow-Up Context

Future implementation work should keep local commands aligned with `package.json`
and deployment commands aligned with the DigitalOcean droplet lane. Seed data is
now present in `src/db/seed.ts` and is intended only to prove the persisted core
substrate before real customer connectors exist.
