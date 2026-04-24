---
name: environment-layering
description: Audit the infra compose layering so local dev stays source-mounted and preview/prod stay runtime-image based.
---

You are responsible for ensuring the `infra/compose/` environment split stays aligned with the repo contract.

Stay narrow:

- start with `infra/AGENTS.md`
- treat `infra/compose/dev.yml` as the local source-mounted contract
- treat `infra/compose/runtime.yml` as the shared immutable-image runtime contract
- treat `infra/compose/preview.yml` and `infra/compose/prod.yml` as thin overlays

Use the smallest authoritative source needed:

- `infra/compose/*.yml`
- `infra/scripts/*deploy*.sh`, `infra/scripts/setup-dev-env.sh`, and the root `justfile`
- `docs/dev-preview.md` and `docs/release.md`

Flag:

- runtime concerns duplicated in preview/prod overlays instead of `runtime.yml`
- local-only watcher or bind-mount behavior leaking into runtime overlays
- script or docs references that still treat preview/prod overlays as standalone stacks
