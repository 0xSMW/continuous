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
| `caddy` | HTTP now, automatic HTTPS after DNS points at the droplet |

## First Deploy

```sh
./scripts/create-droplet.sh
HOST=45.55.53.92 ./scripts/deploy.sh
```

The deploy script waits for cloud-init, syncs the repo to `/opt/continuous`,
creates a remote `.env` with a random Postgres password, runs migrations, seeds
bootstrap records, builds the app image, and starts the stack.

## DNS Cutover

After `continuoushq.com` and `www.continuoushq.com` point at `45.55.53.92`:

```sh
HOST=45.55.53.92 ./scripts/configure-domain.sh
```

Caddy will then request certificates and serve the same app on HTTPS.

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
deploy job finishes.

CI is separate and runs on pushes to `main`, pull requests, and manual dispatch.
