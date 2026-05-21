# Continuous deployment

This deploys one Ubuntu droplet on DigitalOcean running Docker Compose:

- `app`: Next.js container built from this repo.
- `worker-scheduler`: internal sidecar that posts canonical `/workflow` and
  `/worker` command envelopes for scheduled workflow step and adapter retry
  drain.
- `db`: private Postgres container with a persistent volume.
- `caddy`: public HTTP/HTTPS reverse proxy.

## Create the droplet

```sh
SSH_KEYS=your-do-ssh-key-id-or-fingerprint ./scripts/create-droplet.sh
```

The script enables DigitalOcean managed backups by default, verifies the
Droplet backup policy after creation or reuse, and reports any available backup
images. Set `ENABLE_MANAGED_BACKUPS=false` only for a throwaway environment; set
`VERIFY_MANAGED_BACKUPS=false` only as a break-glass override.

Defaults:

- `NAME=continuous-01`
- `REGION=nyc3`
- `SIZE=s-2vcpu-4gb`
- `IMAGE=ubuntu-24-04-x64`
- `ENABLE_MANAGED_BACKUPS=true`
- `VERIFY_MANAGED_BACKUPS=$ENABLE_MANAGED_BACKUPS`

## Deploy

```sh
HOST=your-droplet-ip ./scripts/deploy.sh
```

The deploy script creates `/opt/continuous/.env` on the droplet with a random
Postgres credential and requires HTTPS `SITE_HOSTS`. The current production hosts
are `continuoushq.com, getcontinuous.app`. The deploy workflow also runs
`scripts/smoke-production-on-host.sh` to verify HTTPS health, closed `/worker`
auth, and Postgres 17 host parity before the deeper production smoke suite.
The GitHub deploy workflow builds a release image archive on the runner, uploads
it to the droplet, verifies its checksum, loads the app/migrate/scheduler images,
and starts Compose with `--no-build` so production releases do not compile source
on the host.

## Backup and restore

Back up the production Postgres volume before risky changes and on a regular
cadence:

```sh
HOST=your-droplet-ip ./scripts/backup-db.sh
```

Restore from a verified custom-format dump:

```sh
HOST=your-droplet-ip BACKUP_FILE=backups/postgres/continuous-postgres-YYYYMMDDTHHMMSSZ.dump CONFIRM_RESTORE=continuous ./scripts/restore-db.sh
```

The backup script writes the dump on the droplet, verifies it with
`pg_restore --list`, copies it to local `backups/postgres/`, and verifies the
local checksum. The restore script is destructive and should be drilled on a
disposable droplet before using it for customer data.

For durable database-level retention, configure an S3-compatible object target
and install the backup timer after deployment:

```sh
HOST=your-droplet-ip \
  BACKUP_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com \
  BACKUP_S3_BUCKET=your-backup-bucket \
  BACKUP_S3_REGION=nyc3 \
  BACKUP_S3_PREFIX=postgres \
  BACKUP_S3_ACCESS_KEY_ID=... \
  BACKUP_S3_SECRET_ACCESS_KEY=... \
  ./scripts/install-backup-timer.sh
```

The timer stores its private environment in
`/etc/continuous/postgres-backup.env` and runs
`/opt/continuous/scripts/backup-db-on-host.sh`, which uploads the verified dump,
checksum sidecar, and `latest.json` manifest. `scripts/check-backup-age.sh`
checks the object manifest when `BACKUP_OBJECT_STORAGE_ENABLED=true`.

After backup scheduling, alerting, recovery-drill evidence, token rotation, and
non-root access are in place, run the strict production readiness gate:

```sh
HOST=your-droplet-ip ./scripts/install-non-root-access.sh
HOST=your-droplet-ip ./scripts/check-production-readiness.sh
```

The same gate can be enforced from the manual deploy workflow with
`require_production_readiness=true`. Leave it off until the required
`/etc/continuous/*` env files and readiness attestations are actually present
on the host.

## Domain DNS

The live domains use registrar DNS, not DigitalOcean DNS zones. Point these
records at the droplet IP in the registrar:

```sh
continuoushq.com      A      your-droplet-ip
getcontinuous.app     A      your-droplet-ip
```

DigitalOcean DNS commands only apply if the nameservers are migrated to
DigitalOcean later.

Refresh Caddy hostnames and automatic TLS:

```sh
HOST=your-droplet-ip SITE_HOSTS="continuoushq.com, getcontinuous.app" ACME_EMAIL=admin@continuoushq.com ./scripts/configure-domain.sh
```
