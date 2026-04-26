# Preview deploys (per-PR, shared box)

Every non-draft PR deploys to a shared Hetzner dev box under its own
`docker compose` project and is reachable at
`https://pr-<number>.preview.red.computer`. Closing a PR tears the project
down; a nightly cron evicts projects older than 14 days so a
forgotten-open PR doesn't burn resources forever.

## Architecture

```
Cloudflare:   *.preview.red.computer  A → dev Hetzner server  (managed by sst @ dev)

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

1. **Provision** the dev Hetzner box through SST:
   ```bash
   dotenvx run -f .env.ci -- just provision dev
   ```
   SST now creates the preview server and the `*.preview.red.computer`
   wildcard DNS record directly. It uses `DEV_SSH_PUBLIC_KEY` for box access
   and syncs exported SST env vars like daemon-memory R2 credentials into the
   target env file.
   When the preview server IP or wildcard DNS changes, re-run
   `dotenvx run -f .env.ci -- just provision dev .env.ci` and commit the
   encrypted `.env.ci` update so GitHub Actions can read `REDC_SERVER_IP`
   without provisioning during each PR workflow.
2. **Run bootstrap** on the box:
   ```bash
   just bootstrap-dev-box <dev-ip>
   ```
   This pushes the remote setup script over SSH, installs docker/dotenvx
   if needed, creates `/opt/red-previews`, creates the `preview-net`
   docker network, installs the eviction cron, uploads `.env.preview`,
   persists `DOTENV_PRIVATE_KEY_PREVIEW` if your local `.env.keys` already
   has it, decrypts `/opt/red-previews/.env` automatically when that key is
   available, and starts the permanent preview Caddy stack on the box.
3. **Keep `.env.preview` current** with the shared preview secrets every PR
   stack needs: `TRIAGE_OPENAI_API_KEY`, `SMITHERS_API_KEY`, etc. Bootstrap
   and preview deploys decrypt that file into `/opt/red-previews/.env` on
   the box, and CI never rsyncs the plaintext `.env`.

## Required repo secrets

| secret | purpose |
|---|---|
| `DEV_SSH_PUBLIC_KEY` | public key injected into the dev box by SST |
| `DEV_SSH_PRIVATE_KEY` | SSH private key; paired public key lives on the dev box |
| `HCLOUD_TOKEN` | sst; same as prod |
| `CLOUDFLARE_API_TOKEN` | sst; must have Zone:DNS edit + R2 edit |
| `CLOUDFLARE_ZONE_ID` | sst |
| `CLOUDFLARE_DEFAULT_ACCOUNT_ID` | sst state bucket lives here |

Triage provider credentials + the Smithers bearer token live on the dev box's
`/opt/red-previews/.env` (not in CI secrets; CI never touches that file).

## What the workflow does

`.github/workflows/preview-deploy.yml`:

| PR event | job |
|---|---|
| opened / synchronize / reopened / ready_for_review | `deploy`: provision dev infra (idempotent) → rsync → compose up → health check → sticky PR comment |
| closed | `teardown`: compose down -v → rm preview dir → sticky PR comment |

Concurrency is per PR (`group: preview-deploy-<pr-number>`,
`cancel-in-progress: true`). Latest push for a given PR supersedes its
earlier deploys without serializing unrelated PR previews behind it.

Draft PRs are skipped (`github.event.pull_request.draft == false`).

## Preview scope

Preview stacks now include every service with a Dockerfile:

- `api` (ctl), `auth`, `grs`, `bff`, `obs`, `triage`, `triage-smithers`, `web`
- supporting: `gateway` (envoy), `db-auth` (postgres), `s3` (minio)

This is intentionally **broader** than production. Preview catches build and
wiring issues for services before they make it into prod. The shared
immutable-image runtime lives in `infra/base/compose.yml`; preview adds the
PR-specific overlay in `infra/preview/compose.yml`.

## Lifecycle cleanup

- Each deploy now tears down the existing stack for that same PR before
  pulling the next image set. That drops the old containers and releases
  their image references before the new deploy starts.
- PR close/merge still triggers `teardown` immediately.
- `.github/workflows/preview-gc.yml` also reconciles the host against the
  current set of open PRs on `pull_request.closed`, on pushes to `main`, and
  nightly. If a close hook is missed, the next reconciliation deletes the
  stale preview directory, compose project, and Caddy site.

## Nightly eviction

`infra/preview/setup-host.sh` installs `/opt/red-previews/preview-cleanup.sh`
at 03:17 UTC via `/etc/cron.d/red-preview-cleanup`, and that host-owned
script tears down any preview whose working directory was last modified more
than 14 days ago.

## Local testing

```bash
# On the dev box (or any docker host with preview-net created and
# /opt/red-previews/.env already present), using an image tag that exists in GHCR:
IMAGE_TAG=<existing-ghcr-tag> \
PREVIEW_PUBLIC_URL=https://pr-local.preview.red.computer \
PREVIEW_WEB_CLIENTS=red-web=https://pr-local.preview.red.computer \
PREVIEW_PASSKEY_ORIGINS=https://pr-local.preview.red.computer \
COMPOSE_PROJECT_NAME=preview-pr-local \
docker compose -f infra/base/compose.yml -f infra/preview/compose.yml up -d
docker inspect preview-pr-local-gateway --format '{{.NetworkSettings.Networks.preview-net.IPAddress}}'
```
