# Releases

Production releases are cut automatically after a push to `main`.

`.github/workflows/build-app-images.yml`:

1. Builds canonical app images for the merged `main` commit, tagged by commit SHA.
2. Computes the next patch release tag (`vX.Y.Z`) unless that commit already has a release tag.
3. Publishes the GitHub Release for that commit.

Publishing the GitHub Release then triggers `.github/workflows/release.yml`, which:

1. Checks out the tag and resolves its commit SHA.
2. Verifies that prebuilt GHCR images already exist for that commit SHA.
3. Adds the human-friendly release tag to those existing image manifests without rebuilding them.
4. Runs `just ci::secrets-check .env.ci production`, then `just provision production`
   → `sst deploy` against Cloudflare + Hetzner,
   then syncs exported SST env vars into the target env file.
5. Writes the SSH private key from secrets.
6. Runs `just deploy-ssh <release-tag> <commit-sha> red.computer 2222` → rsyncs the
   working tree to `/opt/red`, decrypts `.env.production`, pulls the tagged GHCR
   images on the server, then `docker compose -f infra/base/compose.yml -f infra/prod/compose.yml up -d`.
7. Runs `just deploy-check https://red.computer` → curl `/health` and fail
   the workflow unless `status == "ok"`.

The human gate is now merging to `main`, not manually publishing a release.

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
- `.env.keys` — dotenvx encryption keys
- `*.db` / `*.db-wal` / `*.db-shm` — sqlite files
- `node_modules`, `.git`, `.sst`

Docker named volumes also survive every deploy; releases now pull immutable GHCR
image tags instead of rebuilding service images on the box.

First-time-server bootstrap still needs a `.env` file dropped in
`/opt/red/.env` manually.

## Normal flow

```bash
merge the PR to main
# build-app-images publishes the next patch release automatically
```

Watch it under:

- Actions → `Build app images`
- Actions → `Release`

If the release workflow says prebuilt images are missing for the tag's commit SHA,
wait for the `Build app images` workflow on that `main` commit to finish, or fix
the branch/tag so the release points at a commit that already landed on `main`.

## Manual backfill

If automation is broken and you need to backfill manually, create and publish a
GitHub Release for a commit that already landed on `main`.

## Rollback

Not automated. If a release breaks prod, re-run the previous release by
publishing a new tag at the previous SHA, or redeploy manually:

```bash
git checkout <good-sha>
just deploy-ssh <release-tag> <good-sha> red.computer 2222
```
