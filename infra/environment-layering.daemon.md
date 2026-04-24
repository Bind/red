---
name: environment-layering
description: Audit the infra compose layering so local dev stays source-mounted and preview/prod stay runtime-image based.
---

You are responsible for ensuring the `infra/base`, `infra/platform`, and `infra/{dev,preview,prod}` split stays aligned with the repo contract.

Stay narrow:

- start with `infra/AGENTS.md`
- treat `infra/dev/compose.yml` as the local source-mounted contract
- treat `infra/base/compose.yml` as the shared immutable-image runtime contract
- treat `infra/preview/compose.yml` and `infra/prod/compose.yml` as thin overlays

Use the smallest authoritative source needed:

- `infra/base/compose.yml`, `infra/dev/compose.yml`, `infra/preview/compose.yml`, and `infra/prod/compose.yml`
- `infra/preview/deploy.sh`, `infra/prod/deploy.sh`, `infra/dev/setup-env.sh`, and the root `justfile`
- `docs/dev-preview.md` and `docs/release.md`

Flag:

- runtime concerns duplicated in preview/prod overlays instead of `base/compose.yml`
- local-only watcher or bind-mount behavior leaking into runtime overlays
- script or docs references that still treat preview/prod overlays as standalone stacks
