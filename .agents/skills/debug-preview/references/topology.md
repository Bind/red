# Preview Topology

## SSH

Typical access pattern:

```bash
TMP_KEY="$(mktemp)"
dotenvx get DEV_SSH_PRIVATE_KEY -f .env.ci --format shell > "$TMP_KEY"
chmod 600 "$TMP_KEY"
ssh -p 2222 -i "$TMP_KEY" root@<dev-box-ip>
```

If `dotenvx get ... --format shell` yields a base64 blob instead of PEM text, decode it before use.

## Host-owned paths

- Preview root: `/opt/red-previews`
- Per-preview checkout: `/opt/red-previews/<slug>`
- Shared preview env: `/opt/red-previews/.env`
- Encrypted preview env: `/opt/red-previews/.env.preview`
- Caddy stack root: `/opt/red-preview-caddy`
- Caddy main config: `/opt/red-preview-caddy/caddy/preview.Caddyfile`
- Per-preview Caddy sites: `/opt/red-preview-caddy/caddy/sites/<slug>.caddy`

## Naming

- PR `9` -> slug `pr-9`
- Compose project -> `preview-pr-9`
- Container names -> `preview-pr-9-<service>`

Examples:

- `preview-pr-9-gateway`
- `preview-pr-9-auth`
- `preview-pr-9-bff`
- `preview-pr-9-api`
- `preview-pr-9-web`

## Running services

The preview overlay keeps these container names stable:

- `gateway`
- `api`
- `bff`
- `auth`
- `db-auth`
- `s3`
- `obs`
- `grs`
- `triage`
- `triage-smithers`
- `web`
- `mcp`

Permanent host-wide service:

- `preview-caddy`

## Internal ports

- `gateway`: `8080`
- `api`: `3000`
- `bff`: `3001`
- `auth`: `4020`
- `obs`: `4090`
- `grs`: `8080`
- `triage`: `7000`
- `triage-smithers`: `7331`
- `mcp`: `3002`
- `db-auth`: `5432`
- `s3`: `9000` (`9001` console inside MinIO)

## Networks

- Shared external network: `preview-net`
- Each preview also has its own compose default bridge network
- `preview-caddy` resolves `<project>-gateway` over `preview-net`

## First-pass commands

List preview containers:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep 'preview-pr-9'
```

Tail one service:

```bash
docker logs --tail 200 preview-pr-9-auth
docker logs --tail 200 preview-pr-9-web
docker logs --tail 200 preview-pr-9-gateway
```

Inspect the preview checkout:

```bash
ls -la /opt/red-previews
ls -la /opt/red-previews/pr-9
```

Inspect ingress routing:

```bash
cat /opt/red-preview-caddy/caddy/sites/pr-9.caddy
docker logs --tail 200 preview-caddy
```

Inspect compose state from the preview checkout:

```bash
cd /opt/red-previews/pr-9
COMPOSE_PROJECT_NAME=preview-pr-9 docker compose -f infra/base/compose.yml -f infra/preview/compose.yml ps
COMPOSE_PROJECT_NAME=preview-pr-9 docker compose -f infra/base/compose.yml -f infra/preview/compose.yml logs auth
```

Check disk headroom when pulls or extracts fail:

```bash
df -h /
df -h /var/lib/containerd
docker system df
```

## Common failure layers

- Caddy/site missing: preview URL 404s before reaching the stack
- Gateway up, backend down: preview URL routes but returns 502/503
- App container up with request errors: inspect app logs and request traces
- Crash loop: `docker ps` shows restarting container; inspect logs immediately
- Host full: image pull or overlay extract fails with `no space left on device`

## Ground truth

The host and preview stack layout are defined by:

- `docs/dev-preview.md`
- `infra/preview/setup.sh`
- `infra/preview/setup-host.sh`
- `infra/preview/deploy.sh`
- `infra/base/compose.yml`
- `infra/preview/compose.yml`
