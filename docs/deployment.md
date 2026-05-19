# Deployment

Continuous currently deploys to one DigitalOcean Ubuntu droplet running Docker
Compose. The app image uses Bun for dependency install, migrations, and seed
commands.

## Resources

- DigitalOcean project: `continuous`
- Droplet: `continuous-01`
- Region: `nyc3`
- Size: `s-2vcpu-4gb`
- Public IP: `45.55.53.92`
- Firewall: `continuous-fw`
- Open inbound ports: SSH from the current operator IP, HTTP, HTTPS

## Services

| Service | Purpose |
|---|---|
| `app` | Next.js server for the core dashboard and APIs |
| `db` | Postgres for graph, task, capability, evidence, budget, adapter, event, and UI-contract records |
| `migrate` | Drizzle migration/seed runner |
| `caddy` | Automatic HTTPS, HTTP redirects, and certificate renewal |

`POST /api/core` is the operator-gated headless Core command surface. It
supports `task.create`, `task.transition`, `object.upsert`, `object.link`,
`event.ingest`, `evidence.attach`, `document.create`, `packet.prepare`,
`document.packet.prepare`, `decision.record`, `approval.request`,
`capability.grant`, `budget.reserve`, `budget.charge`,
`budget.release`, and `view.publish`, all with the same bearer token used by
worker and workflow commands.

## First Deploy

```sh
./scripts/create-droplet.sh
HOST=45.55.53.92 ./scripts/deploy.sh
```

The deploy script waits for cloud-init, syncs the repo to `/opt/continuous`,
creates a remote `.env` with a random Postgres password, runs migrations, seeds
bootstrap records, builds the app image, and starts the stack. After DNS is
pointed, the default hosts are `continuoushq.com, getcontinuous.app` and the
default app URL is `https://continuoushq.com`.

## Domain State

`continuoushq.com` and `getcontinuous.app` currently point at `45.55.53.92`.
Refresh the Caddy hostnames explicitly when domain records change:

```sh
HOST=45.55.53.92 SITE_HOSTS="continuoushq.com, getcontinuous.app" ./scripts/configure-domain.sh
```

Caddy requests a publicly trusted certificate through Let's Encrypt, persists
the ACME account and certificates in the `caddy_data` Docker volume, redirects
HTTP to HTTPS, and renews certificates automatically before they expire. If
`www` hostnames should serve the app, include them in `SITE_HOSTS` before
rerunning `scripts/configure-domain.sh` or the deploy workflow.

## GitHub Deploy

The `Deploy` workflow is manual-only and uses these repository secrets:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_KEY`
- `DEPLOY_PATH`
- `ACME_EMAIL`
- `DO_API_TOKEN`

The workflow uses `DO_API_TOKEN` to add the current GitHub runner IP as a
temporary `/32` SSH source on `continuous-fw`, then removes that rule after the
deploy job finishes. When `app_url` is omitted, the workflow derives `APP_URL`
from the first hostname in `site_hosts`, matching `scripts/deploy.sh`.

CI is separate and runs on pushes to `main`, pull requests, and manual dispatch.

## Post-Deploy Verification

```sh
curl -fsS https://continuoushq.com/api/health
curl -fsS https://getcontinuous.app/api/health
openssl s_client -connect 45.55.53.92:443 -servername continuoushq.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

The deploy path enables the generic worker command surface with a generated
bearer token in `/opt/continuous/.env`. `WORKER_OPERATOR_EMAIL` defaults to the
seeded owner user and must match an active user before approval records or
operator decisions can be written. Use the CLI path over SSH for direct
operator-controlled smoke runs:

```sh
ssh root@45.55.53.92 'cd /opt/continuous && docker compose --profile tools run --rm migrate bun run worker:tool worker.run --payload='"'"'{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"deploy-worker-run-001","config":{"intake":{"objectId":"lead_object_uuid","eventId":"lead_received_event_uuid","evidenceId":"lead_snapshot_evidence_uuid"}}}'"'"''
```

For the HTTPS worker API path, call `POST /worker` with `command`, `worker`,
`config`, and `idempotencyKey` fields as required by the command plus the bearer
token from `/opt/continuous/.env`. Revenue Worker runs should first create the
lead object, `lead.received` event, and source snapshot through `/api/core`, then
pass those ids under `config.intake`. `GET /api/core`, `GET /worker?view=snapshot`, and
`GET /worker?view=approvals` use the same bearer token for operator-only
snapshots and approval review. Worker-specific HTTP paths are intentionally
absent; expand the worker control plane through registered `/worker` commands
and payload fields.
The deploy workflow smokes Core lead intake before `/worker`, then covers
`/api/core` task creation, task transition, approval request, capability grant,
budget reserve/charge/release, object, object-link, event, evidence, document,
packet, decision, and generated-view commands after each production rollout.
