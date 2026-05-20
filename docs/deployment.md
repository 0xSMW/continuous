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
| `worker-scheduler` | Internal scheduler that posts canonical `/workflow` and `/worker` command envelopes to drain workflow steps and Revenue adapter retry/reconciliation work |
| `db` | Postgres for graph, task, capability, evidence, budget, adapter, event, and UI-contract records |
| `migrate` | Drizzle migration/seed runner |
| `caddy` | Automatic HTTPS, HTTP redirects, and certificate renewal |

`POST /core` is the operator-gated headless Core command surface. It
supports `task.create`, `task.transition`, `object.upsert`, `object.link`,
`event.ingest`, `evidence.attach`, `document.create`, `packet.prepare`,
`document.packet.prepare`, `decision.record`, `approval.request`,
`capability.grant`, `budget.reserve`, `budget.charge`,
`budget.release`, `view.publish`, `adapter.intent.record`, `rule.change.record`, `customer_signal.record`,
`payroll.preview.record`, and `payroll.preview.packet.prepare`, all with the
same bearer token used by worker and workflow commands.

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
Each normal deploy tags app images as `sha-<commit>` by default, or the
provided `app_tag`, and stores the prior app tag as `PREVIOUS_APP_TAG` in the
remote `.env`.
Deploys also derive a control-plane token catalog from the generated
`WORKER_RUN_TOKEN`: the raw token remains in `.env` for operator smoke calls,
while app containers receive a hashed `CONTROL_PLANE_TOKEN_CATALOG_B64` entry
with explicit route, command, tenant, worker-role, and read/write scope. Future
tokens can be added with `CONTROL_PLANE_TOKENS_JSON` or the base64 catalog
without changing `/core`, `/worker`, `/workflow`, or `/approval`.

To roll back only the app and scheduler containers to an existing image tag,
dispatch `Deploy` with `rollback_app_tag` set. The rollback path does not run
migrations or seed commands; it updates `APP_TAG`, restarts `app` and
`worker-scheduler` with `--no-build`, and then runs the same production smoke
checks. Use it only when the database is still compatible with that image.

The same rollback can run from the operator shell:

```sh
HOST=45.55.53.92 APP_TAG=sha-previous ./scripts/rollback-app.sh
```

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
operator decisions can be written. The deploy path also writes a hashed
control-plane token catalog and scopes that credential to
`CONTROL_PLANE_ALLOWED_TENANTS=continuous-demo` and
`CONTROL_PLANE_ALLOWED_WORKER_ROLES=revenue_operations,owner_chief_of_staff`;
requests to `/worker`, `/core`, or `/workflow` must carry an allowed
`tenantSlug`, and worker requests must carry an allowed `worker.role`. Use the
CLI path over SSH for direct operator-controlled smoke runs:

```sh
ssh root@45.55.53.92 'cd /opt/continuous && docker compose --profile tools run --rm migrate bun run worker:tool worker.lead.read --payload='"'"'{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"deploy-lead-read-001","config":{"source":"website_form","records":[{"sourceEventId":"deploy-form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'"'"''
ssh root@45.55.53.92 'cd /opt/continuous && docker compose --profile tools run --rm migrate bun run worker:tool worker.run --payload='"'"'{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"deploy-worker-run-001","config":{"intake":{"source":"website_form","sourceEventId":"deploy-form-001"}}}'"'"''
```

The deploy path also starts the `worker-scheduler` profile. The scheduler uses
`WORKER_SCHEDULER_BASE_URL=http://app:3000`, the generated worker token, and
tenant `continuous-demo` to call the same production APIs an operator would
call: `/workflow` with `command=steps.execute`, then `/worker` with
`command=adapters.retry` and `command=adapters.reconcile`. It does not execute
external sends or money movement; it only drains queued internal work already
covered by the command registry and workflow step ledger.

For the HTTPS worker API path, call `POST /worker` with `command`, `worker`,
`config`, and `idempotencyKey` fields as required by the command plus the bearer
token from `/opt/continuous/.env`. Revenue Worker runs should first create the
lead object, `lead.received` event, and source snapshot through
`command=lead.read`, then pass the stable source selector under `config.intake`:

```json
{
  "command": "lead.read",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "deploy-lead-read-001",
  "config": {
    "source": "website_form",
    "records": [
      {
        "sourceEventId": "lead_source_event_id",
        "customerName": "Acme Roof Repair",
        "customerIntent": "roof leak inspection"
      }
    ]
  }
}
```

```json
{
  "command": "run",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "deploy-worker-run-001",
  "config": {
    "intake": {
      "source": "website_form",
      "sourceEventId": "lead_source_event_id"
    }
  }
}
```

Workflow handlers that already hold Core UUIDs can pass those ids under
`config.intake`. `GET /core`,
`GET /worker?view=snapshot&role=revenue_operations`, and
`GET /worker?view=approvals&role=revenue_operations` use the same bearer token for operator-only
snapshots and approval review. Worker-specific HTTP paths are intentionally
absent; expand the worker control plane through registered `/worker` commands
and payload fields.
The deploy workflow smokes `lead.read`, the source-selector `run` path, adapter
reconciliation, continuation, and `/core` task creation, task transition,
approval request, capability grant, budget reserve/charge/release, object,
object-link, event, evidence, document, packet, decision, generated-view,
shared approval inbox route, payroll preview packet handoff, and payroll
approval handoff after each production rollout.

Control-plane token catalog entries have this shape when provided directly via
`CONTROL_PLANE_TOKENS_JSON`:

```json
[
  {
    "id": "operator-token-id",
    "tokenSha256": "hex_sha256_of_bearer_token",
    "operatorEmail": "owner@continuoushq.com",
    "allowedTenants": ["continuous-demo"],
    "allowedWorkerRoles": ["revenue_operations", "owner_chief_of_staff"],
    "allowedRoutes": ["core", "worker", "workflow", "approval"],
    "allowedAccess": ["read", "write"],
    "allowedCommands": ["*"],
    "expiresAt": "2026-06-20T00:00:00.000Z"
  }
]
```

`allowedCommands` accepts exact route-qualified keys such as `worker:run` or
route wildcards such as `worker:*`. GET views are authorized as
`<route>:view.<view>`, for example `worker:view.snapshot`.

## Database Backup And Restore

Postgres is the only production stateful service today. The `postgres_data`
Docker volume must have an off-box backup before the droplet is used for real
customer data. DigitalOcean managed droplet backups are enabled for
`continuous-01` as the baseline off-host recovery layer.

Create a verified custom-format dump on the droplet and copy it to local
`backups/postgres/`:

```sh
HOST=45.55.53.92 ./scripts/backup-db.sh
```

Useful options:

```sh
HOST=45.55.53.92 \
  REMOTE_BACKUP_DIR=/opt/continuous/backups/postgres \
  LOCAL_BACKUP_DIR=backups/postgres \
  RETENTION_DAYS=14 \
  ./scripts/backup-db.sh
```

The backup script writes a `.sha256` sidecar next to the droplet dump and next
to any local copy. It can also upload the verified dump, checksum sidecar, and
`latest.json` manifest to an S3-compatible object store such as DigitalOcean
Spaces:

```sh
HOST=45.55.53.92 \
  BACKUP_OBJECT_STORAGE_ENABLED=true \
  BACKUP_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
  BACKUP_S3_BUCKET=continuous-db-backups \
  BACKUP_S3_REGION=nyc3 \
  BACKUP_S3_PREFIX=postgres \
  BACKUP_S3_ACCESS_KEY_ID=... \
  BACKUP_S3_SECRET_ACCESS_KEY=... \
  ./scripts/backup-db.sh
```

Do not commit object-storage credentials. Keep the bucket name, endpoint, and
prefix in deployment notes, and store access keys in the operator shell,
GitHub/environment secrets, or `/etc/continuous/postgres-backup.env` on the
droplet.

Install the daily systemd timer after object-storage credentials are available
and the latest repo has been deployed to `/opt/continuous`:

```sh
HOST=45.55.53.92 \
  BACKUP_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
  BACKUP_S3_BUCKET=continuous-db-backups \
  BACKUP_S3_REGION=nyc3 \
  BACKUP_S3_PREFIX=postgres \
  BACKUP_S3_ACCESS_KEY_ID=... \
  BACKUP_S3_SECRET_ACCESS_KEY=... \
  ./scripts/install-backup-timer.sh
```

The timer runs `scripts/backup-db-on-host.sh`, keeps local droplet dump
retention through `RETENTION_DAYS`, and writes off-host copies plus a latest
manifest. Check that the latest droplet dump and optional object-store manifest
are fresh before a release or after changing recovery automation:

```sh
HOST=45.55.53.92 MAX_AGE_HOURS=26 ./scripts/check-backup-age.sh

HOST=45.55.53.92 \
  BACKUP_OBJECT_STORAGE_ENABLED=true \
  BACKUP_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
  BACKUP_S3_BUCKET=continuous-db-backups \
  BACKUP_S3_REGION=nyc3 \
  BACKUP_S3_PREFIX=postgres \
  BACKUP_S3_ACCESS_KEY_ID=... \
  BACKUP_S3_SECRET_ACCESS_KEY=... \
  ./scripts/check-backup-age.sh
```

Restore is intentionally destructive and requires an explicit confirmation
variable. It stops the app only after checksum verification and archive
validation pass. By default it first restores into a scratch database on the
same Postgres instance, then drops/recreates the production database, restores
the dump, runs migrations, restarts the app, and checks app health:

```sh
HOST=45.55.53.92 \
  BACKUP_FILE=backups/postgres/continuous-postgres-20260520T000000Z.dump \
  CONFIRM_RESTORE=continuous \
  ./scripts/restore-db.sh
```

For a dump already on the droplet, use `REMOTE_BACKUP_FILE` instead of
`BACKUP_FILE`:

```sh
HOST=45.55.53.92 \
  REMOTE_BACKUP_FILE=/opt/continuous/backups/postgres/continuous-postgres-20260520T000000Z.dump \
  CONFIRM_RESTORE=continuous \
  ./scripts/restore-db.sh
```

Run a restore drill on a disposable droplet before relying on a backup for
customer data. Rollback still requires a compatible database backup because
migrations are forward-only.

## Remaining Production Hardening

- Drill app tag rollback and database restore together on a disposable droplet,
  then document the exact recovery timing and compatibility boundary.
- Add log retention, Caddy access logs, metrics, and alerting around health,
  disk, certificate renewal, backup age, and failed jobs.
- Split the single operator bearer token into scoped credentials before adding
  multiple real operators or customer data.
- Replace root SSH deployment with a dedicated deploy user and least-privilege
  sudo policy.
