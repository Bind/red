# Releases

Releases are cut by publishing a **GitHub Release** in the repo. That event
triggers `.github/workflows/release.yml`, which:

1. Checks out the tag.
2. Builds and pushes the controlled service images to GHCR, tagged by commit SHA
   and the release version.
3. Runs `just provision production` → `sst deploy` against Cloudflare + Hetzner,
   then syncs exported SST env vars into the target env file.
4. Writes the SSH private key from secrets.
5. Runs `just deploy-ssh <release-tag> <commit-sha> red.computer 2222` → rsyncs the
   working tree to `/opt/redc`, decrypts `.env.production`, pulls the tagged GHCR
   images on the server, then `docker compose -f infra/base/compose.yml -f infra/prod/compose.yml up -d`.
6. Runs `just deploy-check https://red.computer` → curl `/health` and fail
   the workflow unless `status == "ok"`.

Only maintainers with repo write access can publish releases, so release
creation itself is the human-in-the-loop gate — no GitHub Environment
approval rules needed.

## Required repo secrets

| name | used by | notes |
|---|---|---|
| `HCLOUD_TOKEN` | sst | Hetzner Cloud API token, Read+Write |
| `CLOUDFLARE_API_TOKEN` | sst | Permissions: `Zone.DNS:Edit` on the zone + `Workers R2 Storage:Edit` for the account |
| `CLOUDFLARE_ZONE_ID` | sst | Already referenced in `sst.config.ts` |
| `CLOUDFLARE_DEFAULT_ACCOUNT_ID` | sst | Required when `home: "cloudflare"` — R2 state bucket lives here |
| `HETZNER_SSH_PUBLIC_KEY` | sst | Public half of the deploy key |
| `HETZNER_SSH_PRIVATE_KEY` | deploy.sh | Private half; written to `~/.ssh/id_ed25519` at job start |

## State backend

SST state lives in Cloudflare R2 (`home: "cloudflare"` in `sst.config.ts`).
The bucket is auto-created under the Cloudflare account associated with
`CLOUDFLARE_DEFAULT_ACCOUNT_ID` on first `sst deploy`.

## Server-owned state (not touched by CI)

`deploy.sh` **excludes** the following from rsync, on purpose — these are
provisioned once on the server and survive every release:

- `.env` — production env vars (`TRIAGE_OPENAI_API_KEY`, `SMITHERS_API_KEY`, etc.)
- `*.db` / `*.db-wal` / `*.db-shm` — sqlite files
- `node_modules`, `.git`, `.sst`

Docker named volumes also survive every deploy; releases now pull immutable GHCR
image tags instead of rebuilding service images on the box.

First-time-server bootstrap still needs a `.env` file dropped in
`/opt/redc/.env` manually.

## Cutting a release

```bash
git tag -a v0.1.0 -m "first cut"
git push origin v0.1.0
# then on GitHub: Releases → Draft new release → pick tag v0.1.0 → Publish
```

Once you click **Publish**, the workflow kicks off. Watch it under
Actions → `Release`.

## Rollback

Not automated. If a release breaks prod, re-run the previous release by
publishing a new tag at the previous SHA, or redeploy manually:

```bash
git checkout <good-sha>
just deploy-ssh <release-tag> <good-sha> red.computer 2222
```
