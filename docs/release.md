# Releases

Production releases are cut automatically after a push to `main`.

`.github/workflows/build-app-images.yml`:

1. Builds canonical app images for the merged `main` commit, tagged by commit SHA.
2. Computes the next patch release tag (`vX.Y.Z`) unless that commit already has a release tag.
3. Publishes the GitHub Release for that commit.

`.github/workflows/release.yml` then deploys production. It supports two entry paths:

1. `workflow_run` after a successful `Build app images` run on `main`:
   this is the normal path for bot-published releases.
2. `release: published`:
   this remains available for manual backfills.

The release workflow:

1. Checks out the tag and resolves its commit SHA.
2. Verifies that prebuilt GHCR images already exist for that commit SHA.
3. Adds the human-friendly release tag to those existing image manifests without rebuilding them.
4. Runs `just ci::secrets-check .env.ci production`, then `just provision production`
   → `sst deploy` against Cloudflare + Hetzner,
   then syncs exported SST env vars into the target env file.
5. Resolves `RED_SERVER_IP` + `RED_DNS_RECORD` from the provisioned SST outputs.
6. Writes the SSH private key from secrets.
7. Runs `just deploy-ssh <release-tag> <commit-sha> <RED_SERVER_IP> 2222` → rsyncs the
   working tree to `/opt/red`, decrypts `.env.production`, pulls the tagged GHCR
   images on the server, then `docker compose -f infra/base/compose.yml -f infra/prod/compose.yml up -d`.
8. Runs a direct plain-HTTP health check against the new box with
   `just ci::wait-for-health http://<RED_SERVER_IP>`.
9. Updates the public Cloudflare `A` record to `RED_SERVER_IP`, waits for public DNS
   to converge, then waits for public HTTPS health on
   `https://<RED_DNS_RECORD>/health`.

The human gate is now merging to `main`, not manually publishing a release.

## Fresh prod host bootstrap

If production needs to move to a fresh Hetzner box, bootstrap the machine
before pointing `red.computer` at it:

```bash
just bootstrap-prod-box <new-prod-ip> 22
```

That uses `HETZNER_SSH_PRIVATE_KEY` from `.env.ci` for initial root access,
uploads `.env.production`, persists `DOTENV_PRIVATE_KEY_PRODUCTION` from your
local `.env.keys` into `/root/.bashrc`, decrypts `/opt/red/.env`, installs
docker + dotenvx if missing, creates `/opt/red`, and moves sshd to port `2222`.

After that, verify:

```bash
ssh -p 2222 root@<new-prod-ip> true
just deploy-ssh <release-tag> <commit-sha> <new-prod-ip> 2222
```

Do not leave `red.computer` with multiple `A` records during cutover. Point it
at exactly one prod host at a time.

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

For a local operator watcher, run:

```bash
just ci::watch-main-release
```

That polls `main` every 300 seconds, records the latest build/release run URLs,
and only runs `just deploy-check https://red.computer` after the matching
release workflow succeeds.

If the release workflow says prebuilt images are missing for the tag's commit SHA,
wait for the `Build app images` workflow on that `main` commit to finish, or fix
the branch/tag so the release points at a commit that already landed on `main`.

If the release workflow fails after `Provision infra`, check whether:

- `RED_SERVER_IP` in `.env.ci` matches the intended host from SST
- the deploy step is targeting the resolved server IP, not stale public DNS
- the public `A` record for `red.computer` actually converged to `RED_SERVER_IP`

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
