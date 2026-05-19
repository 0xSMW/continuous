# Continuous deployment

This deploys one Ubuntu droplet on DigitalOcean running Docker Compose:

- `app`: Next.js container built from this repo.
- `db`: private Postgres container with a persistent volume.
- `caddy`: public HTTP/HTTPS reverse proxy.

## Create the droplet

```sh
SSH_KEYS=your-do-ssh-key-id-or-fingerprint ./scripts/create-droplet.sh
```

Defaults:

- `NAME=continuous-01`
- `REGION=nyc3`
- `SIZE=s-2vcpu-4gb`
- `IMAGE=ubuntu-24-04-x64`

## Deploy

```sh
HOST=your-droplet-ip ./scripts/deploy.sh
```

The deploy script creates `/opt/continuous/.env` on the droplet with a random
Postgres password and requires HTTPS `SITE_HOSTS`. The current production hosts
are `continuoushq.com, getcontinuous.app`.

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
