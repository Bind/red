# Preview deploys (per-PR, shared box)

Every non-draft PR deploys to a shared Hetzner dev box under its own
`docker compose` project and is reachable at
`https://pr-<number>.preview.red.computer`. Closing a PR tears the project
down; a nightly cron evicts projects older than 14 days so a
forgotten-open PR doesn't burn resources forever.

## Architecture

```
Cloudflare:   *.preview.red.computer  A → DEV_SERVER_IP       (managed by sst @ dev)

Dev box:
  preview-caddy       (permanent; one instance; wildcard host routing)
  preview-net         (shared docker network)

  preview-pr-42/      ←─┐
    api, auth, grs,    │
    db-auth, s3,       │  one docker compose project per PR
    gateway            │  joined to preview-net via `gateway` container
                       │  name: `preview-pr-42-gateway`
  preview-pr-43/      ←─┘
    ...
```

Caddy resolves `pr-42.preview.red.computer` → `preview-pr-42-gateway:8080`
via docker's embedded DNS on the shared `preview-net`.

## One-time dev-box setup

1. **Provision** a Hetzner box (cax11 = 4 GB = fits ~2–3 previews;
   cax21 = 8 GB ≈ 5; cax31 = 16 GB ≈ 10). Drop your dev SSH key in
   during creation. Note the IP — you'll add it as
   the `DEV_SERVER_IP` repo secret.
2. **Run bootstrap** on the box:
   ```bash
   scp infra/scripts/setup-dev-box.sh root@<dev-ip>:/root/
   ssh root@<dev-ip> bash /root/setup-dev-box.sh
   ```
   Installs docker (if missing), creates `/opt/redc-previews`, the
   `preview-net` docker network, and the nightly eviction cron.
3. **Clone the repo** on the box (one time, just so the Caddy can read
   the preview Caddyfile):
   ```bash
   ssh root@<dev-ip>
   cd /opt && git clone <repo-url> redc
   cd redc && docker compose -f infra/compose/preview-caddy.yml up -d
   ```
4. **Drop a production-style `.env`** at `/opt/redc-previews/.env` with the
   secrets every preview needs: `ANTHROPIC_API_KEY`, `SMITHERS_API_KEY`,
   etc. This file is intentionally *not* rsynced from CI — previews
   read it via `env_file` in `infra/compose/preview.yml`.

## Required repo secrets

| secret | purpose |
|---|---|
| `DEV_SERVER_IP` | dev box IP, used by sst + deploy scripts |
| `DEV_SSH_PRIVATE_KEY` | SSH private key; paired public key lives on the dev box |
| `HCLOUD_TOKEN` | sst; same as prod |
| `CLOUDFLARE_API_TOKEN` | sst; must have Zone:DNS edit + R2 edit |
| `CLOUDFLARE_ZONE_ID` | sst |
| `CLOUDFLARE_DEFAULT_ACCOUNT_ID` | sst state bucket lives here |

Anthropic + Smithers keys live on the dev box's `/opt/redc-previews/.env`
(not in CI secrets; CI never touches that file).

## What the workflow does

`.github/workflows/preview-deploy.yml`:

| PR event | job |
|---|---|
| opened / synchronize / reopened / ready_for_review | `deploy`: sst deploy dev (idempotent) → rsync → compose up → health check → sticky PR comment |
| closed | `teardown`: compose down -v → rm preview dir → sticky PR comment |

Concurrency: `group: preview-deploy`, `cancel-in-progress: true`. Latest
PR push supersedes earlier deploys on the shared box.

Draft PRs are skipped (`github.event.pull_request.draft == false`).

## Preview scope

Preview stacks now include every service with a Dockerfile:

- `api` (ctl), `auth`, `grs`, `bff`, `obs`, `triage`, `triage-smithers`, `web`
- supporting: `gateway` (envoy), `db-auth` (postgres), `s3` (minio)

This is intentionally **broader** than `infra/compose/prod.yml`, which today
only ships the `api` + `gateway` + `caddy` trio. Preview catches build and
wiring issues for services before they make it into prod. When a service
enters prod, preview already proves it deploys cleanly.

## Nightly eviction

`infra/scripts/evict-old-previews.sh` runs at 03:17 UTC via cron
(`/etc/cron.d/redc-preview-evict`) and tears down any preview whose
working directory was last modified >14 days ago.

## Local testing

```bash
# On the dev box (or any docker host with preview-net created):
COMPOSE_PROJECT_NAME=preview-pr-local docker compose -f infra/compose/preview.yml up -d --build
docker inspect preview-pr-local-gateway --format '{{.NetworkSettings.Networks.preview-net.IPAddress}}'
```
