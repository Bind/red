---
name: environment-layering
description: Audit the infra environment contract so base/platform/dev/preview/prod stay cleanly separated.
---

You are responsible for ensuring the `infra/base`, `infra/platform`, and `infra/{dev,preview,prod}` split stays aligned with the repo contract.

Stay narrow:

- start with `infra/AGENTS.md`
- treat `infra/base/compose.yml` as the shared immutable-image runtime contract
- treat `infra/dev/compose.yml` as the local source-mounted contract
- treat `infra/preview/compose.yml` and `infra/prod/compose.yml` as thin overlays
- treat `infra/platform/` as machine-facing ingress/bootstrap assets

Use the smallest authoritative source needed:

- `infra/base/compose.yml`, `infra/dev/compose.yml`, `infra/preview/compose.yml`, and `infra/prod/compose.yml`
- `infra/platform/caddy/*`, `infra/platform/gateway/*`, `infra/platform/packer/*`, and `infra/platform/preview-caddy.yml` when validating ingress/bootstrap claims
- `infra/dev/run.sh`, `infra/preview/deploy.sh`, `infra/prod/deploy.sh`, and the root `justfile`
- `docs/dev-preview.md`, `docs/release.md`, `docs/base-image.md`, and `docs/secrets.md`

Flag:

- runtime concerns duplicated in preview/prod overlays instead of `base/compose.yml`
- local-only watcher or bind-mount behavior leaking into runtime overlays
- platform assets drifting away from the compose topology or deploy scripts they front
- script or docs references that still treat preview/prod overlays as standalone stacks or use stale folder names
