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
| `worker-scheduler` | Internal scheduler that posts canonical `/workflow` and `/worker` command envelopes to drain workflow steps, poll Revenue lead sources, and run Revenue adapter retry/reconciliation work |
| `db` | Postgres for graph, task, capability, evidence, budget, adapter, event, and UI-contract records |
| `migrate` | Drizzle migration/seed runner |
| `caddy` | Automatic HTTPS, HTTP redirects, and certificate renewal |

`POST /core` is the operator-gated headless Core command surface. It
supports `task.create`, `task.transition`, `object.upsert`, `object.link`,
`adapter.upsert`, `connection.upsert`, `connection.health.record`,
`event.ingest`, `evidence.attach`, `document.create`, `packet.prepare`, `document.packet.prepare`,
`decision.record`, `approval.request`, `capability.grant`, `budget.reserve`,
`budget.charge`, `budget.release`, `ai.infer`, `view.publish`, `adapter.intent.record`,
`rule.change.record`, `customer_signal.record`,
`payroll.preview.record`, and `payroll.preview.packet.prepare`, all with the
same bearer token used by worker and workflow commands.

## First Deploy

```sh
./scripts/create-droplet.sh
HOST=45.55.53.92 ./scripts/deploy.sh
```

The deploy script waits for cloud-init, syncs the repo to `/opt/continuous`,
creates a remote `.env` with a random Postgres credential, runs migrations, seeds
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
Caddy access logs are written as JSON to `logs/caddy/access.log` on the
droplet with built-in Caddy rotation at 10 MiB, 10 retained files, and 30 days.

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
Deploy syncs still use `rsync --delete` to remove stale source files, but they
protect `backups/`, `logs/`, and `reports/recovery-drills/` so database dumps,
Caddy/observability logs, and recovery evidence survive releases.

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
`CONTROL_PLANE_ALLOWED_WORKER_ROLES=revenue_operations,owner_chief_of_staff,dispatch_operations,finance_operations`;
requests to `/worker`, `/core`, or `/workflow` must carry an allowed
`tenantSlug`, and worker requests must carry an allowed `worker.role`. Use the
CLI path over SSH for direct operator-controlled smoke runs:

```sh
ssh root@45.55.53.92 'cd /opt/continuous && docker compose --profile tools run --rm migrate bun run worker:tool worker.command --payload='"'"'{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"deploy-lead-read-001","config":{"source":"website_form","records":[{"sourceEventId":"deploy-form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'"'"''
ssh root@45.55.53.92 'cd /opt/continuous && docker compose --profile tools run --rm migrate bun run worker:tool worker.command --payload='"'"'{"command":"run","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"deploy-worker-run-001","config":{"intake":{"source":"website_form","sourceEventId":"deploy-form-001"}}}'"'"''
```

The deploy path also starts the `worker-scheduler` profile. The scheduler uses
`WORKER_SCHEDULER_BASE_URL=http://app:3000`, the generated worker token, and
tenant `continuous-demo` to call the same production APIs an operator would
call: `/workflow` with `command=steps.execute`, `/worker` with
`command=lead.read` for active connections whose `config.polling.enabled` is
true, `/worker` with `command=run` once for each returned intake selector, then
`/worker` with `command=adapters.retry` and `command=adapters.reconcile`.
Lead source, reader kind, provider, and
connection credential references live under the `config` payload, not in the
route name. `WORKER_SCHEDULER_LEAD_POLL_LIMIT` caps poll attempts per cycle and
defaults to `5`. The scheduler does not execute external sends or money
movement; it only drains queued internal work already covered by the command
registry and workflow step ledger.

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

For connection-backed source reads, the request still carries only a connection
reference under `config.reader`. The active connection can provide buffered
records, or a read-only polling config with an environment-backed credential
reference on the server. Provider tokens are never sent in the request payload;
the response records `connectionId`, `cursor`, `sourceMode`, and a redacted
polling receipt when the read came from an API poll.

Create the adapter and connection through `/core` before enabling scheduled
polling. `adapter.upsert` owns the reusable connector catalog row, and
`connection.upsert` owns the tenant-scoped account, scopes, and polling config.
Managed credential refs such as `env:GOOGLE_WORKSPACE_TOKEN` are allowed;
inline access tokens, passwords, and client secrets are rejected.

```json
{
  "command": "adapter.upsert",
  "core": {
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "google-workspace-adapter-001",
  "config": {
    "key": "google_workspace",
    "name": "Google Workspace",
    "kind": "inbox",
    "auth": "oauth",
    "capabilities": {
      "read": ["lead.read"],
      "sources": ["google_workspace_inbox"],
      "providers": ["google_workspace"],
      "readerKinds": ["inbox"]
    }
  }
}
```

```json
{
  "command": "connection.upsert",
  "core": {
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "google-workspace-leads-connection-001",
  "config": {
    "adapterKey": "google_workspace",
    "name": "Google Workspace lead inbox",
    "state": "active",
    "externalAccountId": "leads@continuoushq.com",
    "scopes": {
      "reads": ["lead.read"]
    },
    "config": {
      "sources": ["google_workspace_inbox"],
      "providers": ["google_workspace"],
      "readerKinds": ["inbox"],
      "polling": {
        "enabled": true,
        "source": "google_workspace_inbox",
        "provider": "google_workspace",
        "credentialRef": "env:GOOGLE_WORKSPACE_TOKEN"
      },
      "externalExecution": "blocked"
    }
  }
}
```

Record a readiness snapshot before relying on scheduler polling. The command
does not make external API calls and does not expose credential values; it
records whether the connection is active, scoped, source/provider configured,
pollable, scheduler-observed, and backed by a managed credential ref.

```json
{
  "command": "connection.health.record",
  "core": {
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "google-workspace-leads-health-001",
  "config": {
    "connectionId": "connection_uuid",
    "checks": [
      "state",
      "adapter",
      "external_execution",
      "credential_ref",
      "source_metadata",
      "scopes",
      "polling",
      "scheduler"
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
The deploy workflow smokes `lead.read`, the source-selector `run` path, a
Core-created active buffered connection, one-shot scheduler `lead.read -> run`
handoff proof, adapter reconciliation, continuation, and `/core` task creation,
task transition, approval request, capability grant, budget
reserve/charge/release, object, object-link, event, evidence, document, packet,
decision, generated-view, connector setup, connection health, shared approval
inbox route, payroll preview packet handoff, and payroll
approval handoff after each production rollout. It also runs the host
observability check so production rollout fails if app/db/Caddy service state,
public health, TLS freshness, disk usage, or Caddy access logging are broken.

Control-plane token catalog entries have this shape when provided directly via
`CONTROL_PLANE_TOKENS_JSON`:

```json
[
  {
    "id": "operator-token-id",
    "tokenSha256": "hex_sha256_of_bearer_token",
    "operatorEmail": "owner@continuoushq.com",
    "allowedTenants": ["continuous-demo"],
    "allowedWorkerRoles": ["revenue_operations", "owner_chief_of_staff", "dispatch_operations"],
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

## Production Readiness Gate

Normal deploys run the production smoke suite plus the non-strict host
observability check. Before the droplet is used for customer data, run the
strict readiness gate from the operator shell:

```sh
HOST=45.55.53.92 ./scripts/check-production-readiness.sh
```

The gate runs on the droplet and requires:

- the Postgres backup timer to be enabled and active;
- `/etc/continuous/postgres-backup.env` to contain object-storage backup
  settings without printing secret values;
- the latest local dump and object-storage manifest to be fresh;
- the observability timer to be enabled and active with
  `REQUIRE_BACKUP_FRESH=true`, `CHECK_SYSTEMD_FAILED=true`, and a non-empty
  `ALERT_WEBHOOK_URL`;
- strict host observability to pass, including failed systemd unit checks;
- `/etc/continuous/production-readiness.env` to attest the completed recovery
  drill, token rotation, managed credential inventory, credential revocation,
  operator session review, control-plane auth audit, and non-root access work.

The readiness attestation file is deliberately operator-owned. It should be
created only after the underlying work is done and should not contain secrets.
For token rotation and operator access review, the timestamp is only the
operator acknowledgement layer: the durable source of truth is the
`control_plane_token_rotation_attestations` row, the managed
`control_plane_credentials` row, the linked `control_plane_auth_sessions`
request audit row, and the generated session review view.

Deploy rotates the bootstrap control-plane token before the new app starts by
running `scripts/rotate-control-plane-token-on-host.sh` against the currently
running app. That records `control_plane.token_rotation.attest` and writes the
non-secret rotation attestation id into this file. If a previous failed deploy
left `.env` rotated before the managed credential row was updated, deploy
preserves the current bootstrap token for that recovery deploy instead of
minting another un-attested token. After the new app is up, deploy smoke runs
`scripts/attest-control-plane-on-host.sh`; that script records the current
bootstrap credential inventory row, revokes a disposable drill credential,
reviews recent bootstrap sessions, and writes the non-secret
credential/auth/session evidence ids into this file. These scripts do not attest
recovery drills, object-storage backups, alerting, or non-root host access.

```sh
install -m 0700 -d /etc/continuous
cat >/etc/continuous/production-readiness.env <<'ENV'
RECOVERY_DRILL_ATTESTED_AT=2026-05-20T00:00:00Z
RECOVERY_DRILL_REPORT=reports/recovery-drills/continuous-recovery-YYYYMMDDTHHMMSSZ.md
TOKEN_ROTATION_ATTESTED_AT=2026-05-20T00:00:00Z
TOKEN_ROTATION_ATTESTATION_ID=00000000-0000-0000-0000-000000000000
CONTROL_PLANE_AUTH_AUDIT_ATTESTED_AT=2026-05-20T00:00:00Z
CONTROL_PLANE_AUTH_SESSION_ID=00000000-0000-0000-0000-000000000000
CONTROL_PLANE_CREDENTIAL_INVENTORY_ATTESTED_AT=2026-05-20T00:00:00Z
CONTROL_PLANE_CREDENTIAL_ID=00000000-0000-0000-0000-000000000000
CONTROL_PLANE_CREDENTIAL_REVOCATION_ATTESTED_AT=2026-05-20T00:00:00Z
CONTROL_PLANE_CREDENTIAL_REVOCATION_AUDIT_ID=00000000-0000-0000-0000-000000000000
CONTROL_PLANE_SESSION_REVIEW_ATTESTED_AT=2026-05-20T00:00:00Z
CONTROL_PLANE_SESSION_REVIEW_VIEW_ID=00000000-0000-0000-0000-000000000000
NON_ROOT_ACCESS_ATTESTED_AT=2026-05-20T00:00:00Z
ENV
chmod 0600 /etc/continuous/production-readiness.env
```

Record the rotation with the Core command surface, keeping operation details in
`config` and sending only token fingerprints, never token material:

```json
{
  "command": "control_plane.token_rotation.attest",
  "core": { "tenantSlug": "continuous-demo" },
  "idempotencyKey": "rotation-attest-YYYYMMDD",
  "config": {
    "credentialId": "operator-credential-id",
    "previousCredentialId": "prior-credential-id",
    "previousTokenFingerprint": "<8-to-64-hex-fingerprint>",
    "nextTokenFingerprint": "<8-to-64-hex-fingerprint>",
    "rotatedAt": "2026-05-20T00:00:00.000Z",
    "reason": "scheduled operator rotation",
    "evidence": {
      "report": "ops/rotation/continuous-YYYYMMDD"
    }
  }
}
```

Record the managed credential inventory row with the same Core envelope. The
runtime still proves the bearer token against the hashed catalog, then the
durable inventory can narrow, pause, expire, or revoke the matching
`credentialId` without changing the API shape:

```json
{
  "command": "control_plane.credential.upsert",
  "core": { "tenantSlug": "continuous-demo" },
  "idempotencyKey": "credential-upsert-YYYYMMDD",
  "config": {
    "credentialId": "bootstrap-operator",
    "displayName": "Bootstrap operator",
    "tokenFingerprint": "<8-to-64-hex-fingerprint>",
    "allowedTenants": ["continuous-demo"],
    "allowedWorkerRoles": [
      "revenue_operations",
      "owner_chief_of_staff",
      "dispatch_operations",
      "finance_operations"
    ],
    "allowedRoutes": ["core", "worker", "workflow", "approval"],
    "allowedAccess": ["read", "write"],
    "allowedCommands": ["core:*", "worker:*", "workflow:*", "approval:*"],
    "evidence": {
      "owner": "ops",
      "source": "scoped control-plane catalog"
    }
  }
}
```

Operator offboarding or incident response should revoke the inventory row
first, then rotate or remove the underlying catalog hash:

```json
{
  "command": "control_plane.credential.revoke",
  "core": { "tenantSlug": "continuous-demo" },
  "idempotencyKey": "credential-revoke-YYYYMMDD",
  "config": {
    "credentialId": "bootstrap-operator",
    "reason": "operator offboarding",
    "evidence": {
      "ticket": "SEC-YYYYMMDD"
    }
  }
}
```

Run an operator session review after inventory or revocation changes. The
command publishes a renderer-neutral review view with safe request metadata and
fingerprints only:

```json
{
  "command": "control_plane.session.review",
  "core": { "tenantSlug": "continuous-demo" },
  "idempotencyKey": "session-review-YYYYMMDD",
  "config": {
    "credentialId": "bootstrap-operator",
    "since": "2026-05-20T00:00:00.000Z",
    "limit": 50
  }
}
```

You can also make the manual deploy workflow enforce the same strict gate by
dispatching it with `require_production_readiness=true`. Keep the default
`false` while backup credentials, alerting, drill evidence, token rotation,
credential inventory, session review, and non-root host access are still being
provisioned.

## Observability

Run the host observability check from the operator shell:

```sh
HOST=45.55.53.92 ./scripts/check-observability.sh
```

The check runs on the droplet and verifies Docker Compose service state,
SNI-routed HTTPS `/api/health` for every configured `SITE_HOSTS` hostname,
certificate freshness, disk usage, and Caddy access-log creation. Backup
freshness and failed systemd unit checks are opt-in so unrelated host units or
not-yet-provisioned object storage do not block ordinary deploys:

```sh
HOST=45.55.53.92 \
  REQUIRE_BACKUP_FRESH=true \
  CHECK_SYSTEMD_FAILED=true \
  ./scripts/check-observability.sh
```

Install the recurring timer after selecting an alert destination:

```sh
HOST=45.55.53.92 \
  ALERT_WEBHOOK_URL=... \
  REQUIRE_BACKUP_FRESH=true \
  ./scripts/install-observability-timer.sh
```

The timer stores private configuration in `/etc/continuous/observability.env`,
runs every 15 minutes by default, appends output to
`logs/observability/check.log`, and sends a compact JSON webhook only on
failure when `ALERT_WEBHOOK_URL` is set.

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

Use the recovery drill harness to exercise an app rollback and database restore
as one measured procedure on a disposable host:

```sh
HOST=203.0.113.10 \
  APP_TAG=sha-previous \
  REMOTE_BACKUP_FILE=/opt/continuous/backups/postgres/continuous-postgres-20260520T000000Z.dump \
  CONFIRM_RECOVERY_DRILL=disposable \
  ./scripts/recovery-drill.sh
```

The harness refuses known production hosts such as `45.55.53.92` unless
`ALLOW_PRODUCTION_RECOVERY_DRILL=true` is set. It runs `scripts/rollback-app.sh`,
then `scripts/restore-db.sh`, captures elapsed times, and writes a local report
under `reports/recovery-drills/` by default. Keep those drill reports out of
committed source unless they are scrubbed and intentionally promoted into
operator notes. The compatibility boundary is explicit: app rollback is
tag-based, database restore is dump-backed, and restored schema/data must be
compatible with the chosen app tag because migrations are forward-only.

## Remaining Production Hardening

- Run `scripts/recovery-drill.sh` against a disposable droplet and document the
  measured recovery timing before using the production droplet for customer
  data.
- Install `scripts/install-observability-timer.sh` with `ALERT_WEBHOOK_URL`
  after choosing an alert destination; deploy smoke already verifies the same
  host checks without requiring a webhook.
- Run `scripts/check-production-readiness.sh` successfully, or dispatch the
  deploy workflow with `require_production_readiness=true`, before treating the
  droplet as customer-data ready.
- Run a real operator token rotation through
  `control_plane.token_rotation.attest`, record the managed credential with
  `control_plane.credential.upsert`, run `control_plane.session.review`,
  reference the rotation, credential, revocation, session review, and recent
  auth session ids in `/etc/continuous/production-readiness.env`, and keep
  the revocation path tested before adding multiple real operators or customer
  data.
- Replace root SSH deployment with a dedicated deploy user and least-privilege
  sudo policy.
