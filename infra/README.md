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

## Deploy by IP

```sh
HOST=your-droplet-ip ./scripts/deploy.sh
```

The first deploy creates `/opt/continuous/.env` on the droplet with a random Postgres password and `SITE_HOSTS=http://:80`, so Caddy serves plain HTTP on the droplet IP.

## Move to continuoushq.com

Point DNS at the droplet:

```sh
doctl compute domain create continuoushq.com --ip-address your-droplet-ip
doctl compute domain records create continuoushq.com --record-type CNAME --record-name www --record-data continuoushq.com.
```

Then switch Caddy to hostnames and automatic TLS:

```sh
HOST=your-droplet-ip ACME_EMAIL=admin@continuoushq.com ./scripts/configure-domain.sh
```
