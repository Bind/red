---
name: environment-boundaries
description: Audit the infra environment contract so base/platform/dev/preview/prod stay cleanly separated.
review:
  max_turns: 18
  routing_categories:
    - name: infra-layering
      description: Base versus dev versus preview versus prod versus platform responsibilities, overlay boundaries, and shared runtime placement.
    - name: preview-operator-surface
      description: Preview host topology, debug-preview skill guidance, and operator-facing docs or scripts that describe environment boundaries.
---

Simple job: make sure each infra part lives in the right layer.

You are responsible for ensuring the `infra/base`, `infra/platform`, and `infra/{dev,preview,prod}` split stays aligned with the repo contract.

Stay narrow:

- start with `infra/AGENTS.md`
- treat `infra/base/compose.yml` as the shared immutable-image runtime contract
- treat `infra/dev/compose.yml` as the local source-mounted contract
- treat `infra/preview/compose.yml` and `infra/prod/compose.yml` as thin overlays
- treat `infra/platform/` as machine-facing ingress/bootstrap assets
- treat `.agents/skills/debug-preview/SKILL.md` and its references as part of the preview operator surface

Use the smallest authoritative source needed:

- `infra/base/compose.yml`, `infra/dev/compose.yml`, `infra/preview/compose.yml`, and `infra/prod/compose.yml`
- `infra/platform/caddy/*`, `infra/platform/gateway/*`, `infra/platform/packer/*`, and `infra/platform/preview-caddy.yml` when validating ingress/bootstrap claims
- `infra/dev/run.sh`, `infra/preview/deploy.sh`, `infra/prod/deploy.sh`, and the root `justfile`
- `docs/dev-preview.md`, `docs/release.md`, `docs/base-image.md`, and `docs/secrets.md`
- `.agents/skills/debug-preview/SKILL.md` and `.agents/skills/debug-preview/references/topology.md` when validating preview box paths, SSH/debug flow, service names, ports, or host-owned files

You are not responsible for:

- low-level compose, Caddy, or gateway topology mismatches unless they indicate a layering boundary failure
- bootstrap/deploy script hygiene issues that do not affect the `base` / `dev` / `preview` / `prod` / `platform` split
- generic lint-, typecheck-, or unit-test-style enforcement

Flag:

- runtime concerns duplicated in preview/prod overlays instead of `base/compose.yml`
- local-only watcher or bind-mount behavior leaking into runtime overlays
- platform assets drifting away from the compose topology or deploy scripts they front
- script or docs references that still treat preview/prod overlays as standalone stacks or use stale folder names
- preview-debug skill guidance that drifts from the actual preview deploy topology, host paths, container naming, or SSH/debug workflow
