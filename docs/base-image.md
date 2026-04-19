# Base image (Packer → hcloud snapshot)

Hetzner doesn't expose an AWS-style AMI marketplace, but named **snapshots**
fill the same niche: a per-account, reusable image referenced by ID anywhere
a server's `image:` field accepts one. We use [Packer](https://www.packer.io)
to build a `redc-base` snapshot so every new box boots in ~1 min with
docker / dotenvx / sshd-on-2222 already in place, instead of running a
5–10 min cloud-init bootstrap each time.

## Layout

```
infra/packer/
  redc-base.pkr.hcl          builder config (hcloud plugin)
  provisioners/
    01-apt.sh                apt update + base tools (curl, jq, rsync, …)
    02-sshd.sh               move sshd to port 2222 (no restart yet)
    03-docker.sh             official docker repo, compose plugin, log rotation
    04-dotenvx.sh            install dotenvx + sanity check
    05-preload-images.sh     docker pull every public base image we use
    06-system.sh             /opt/redc layout, sysctl tuning, ufw default-deny
```

Provisioners run in order on a temporary `cax11` in `nbg1`. At the end,
Packer shuts down the box, takes a snapshot, and tears it down — leaving
just the snapshot in your account.

## Building

```bash
just image-build
```

This runs `packer init` + `packer build` through `dotenvx run -f .env.ci`
so `HCLOUD_TOKEN` is injected from the encrypted env. The snapshot is
named `redc-base-<unix-timestamp>` by default; override with a direct
`packer build -var snapshot_name=...` invocation if you need a specific
name.

The run prints the snapshot ID (and name) at the end. A full build on a
cax11 takes 4–6 min (the bulk is `docker pull` of the preloaded images).

## Using the snapshot

Export the ID alongside the other CI secrets:

```bash
dotenvx set REDC_BASE_SNAPSHOT_ID="<id>" -f .env.ci
git add .env.ci && git commit -m "chore: pin redc-base snapshot"
```

Next `sst deploy --stage production` will build the prod server on top of
the snapshot. When `REDC_BASE_SNAPSHOT_ID` is unset, `sst.config.ts` falls
back to stock `ubuntu-24.04` plus a minimal cloud-init — so the snapshot
is a pure optimisation, never a hard requirement.

You can also set it on the dev box path: the dev box is provisioned
manually but you can create it from the snapshot via the Hetzner console
(**Servers → Add → Image → Snapshots**).

## Listing snapshots

```bash
just image-list
```

Returns every snapshot with the `role=redc-base` label (applied by packer)
so rogue snapshots from unrelated experiments don't clutter the output.

## Rebuild cadence

Rebuild the snapshot when:
- You bump the preloaded image list (`05-preload-images.sh`)
- A base tool (docker, dotenvx, ufw) gets a security fix worth baking in
- Ubuntu 24.04 ships point releases with material security updates

Old snapshots hang around until you delete them via the Hetzner console or
API. They cost ~€0.01/GB/month so it's cheap to keep a couple of generations
around for rollback.

## Rollback

If a new snapshot breaks `sst deploy`, point `REDC_BASE_SNAPSHOT_ID` at
the previous snapshot ID, re-commit `.env.ci`, and redeploy. SST will
recreate the prod server on the known-good image.

## CI automation (not wired yet, intentional)

The image build is a maintainer-run step today (`just image-build`). If
the provisioner list starts churning, the obvious next step is a
workflow_dispatch-triggered `.github/workflows/image-build.yml` that
runs packer and commits the new snapshot ID to `.env.ci`. Out of scope
for now; file an issue when the manual step becomes a burden.
