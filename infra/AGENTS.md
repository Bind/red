# Infra Agents Guide

This directory owns the repo's infrastructure surface: local development
wiring, preview and production deployment manifests, gateway and proxy
config, machine bootstrap, and the base image build path.

Treat `infra/` as operational code. Changes here can break local
development, preview deploys, CI bootstrap, or production rollout even when
application code is unchanged.

## Progressive Disclosure

Read only the files needed for the task at hand.

Start from the narrowest relevant area:

- `compose/` for service topology, ports, volumes, env wiring, and runtime
  dependencies
- `scripts/` for bootstrap, deploy, teardown, and operator workflows
- `platform/caddy/` for public HTTP entrypoints and host/path routing
- `gateway/` for Envoy config and gateway container behavior
- `packer/` for base image provisioning and snapshot build concerns

Pull in broader context only when the local file points to it:

- root `justfile` for the command surface that invokes infra scripts
- `sst.config.ts` for cloud resource ownership and environment provisioning
- `docs/release.md`, `docs/dev-preview.md`, `docs/base-image.md`,
  `docs/secrets.md`, and `docs/mcp.md` for intended operator behavior

Do not read the whole repo by default. Stay local unless the infra file you
are auditing clearly depends on an external contract.

## Folder Map

- `base/`
  - `compose.yml` is the immutable-image runtime layer shared by preview and
    production deploys
  - Dockerfiles here are shared container build primitives
- `ci/`
  - owns CI/bootstrap helpers such as env seeding and Codex auth setup
- `platform/`
  - owns Caddy, gateway, Packer, and other machine-facing bootstrap assets
  - `preview-caddy.yml` defines the permanent wildcard ingress for preview
    stacks
- `dev/`
  - `compose.yml` is the local development override used by root `just up` /
    `just down`
  - owns local bootstrap helpers such as `setup-env.sh`
- `preview/`
  - `compose.yml` is the per-PR preview overlay applied on top of
    `base/compose.yml`
  - owns preview deploy, teardown, eviction, and box bootstrap scripts
- `prod/`
  - `compose.yml` is the production overlay applied on top of
    `base/compose.yml`
  - owns the production deploy script

## Core Invariants

- `infra/dev/compose.yml` remains the source of truth for the root local
  docker compose workflow and should stay source-mounted / hot-reload-first.
- `infra/base/compose.yml` is the shared immutable-image runtime contract
  for preview and production.
- `infra/prod/compose.yml` and `infra/preview/compose.yml` are thin overlays
  on top of `base/compose.yml`, not standalone stacks.
- Preview should still exercise a broader surface than production so it
  catches wiring issues before production rollout.
- Preview and production deploy paths must preserve server-owned state.
  Deploy automation must not overwrite long-lived `.env`, sqlite files,
  `.git`, `.sst`, or equivalent host-resident state.
- Preview stacks are isolated per PR via `COMPOSE_PROJECT_NAME`, while
  sharing only the intentionally shared preview ingress/network surface.
- Scripts under `infra/ci/`, `infra/dev/`, `infra/preview/`, and
  `infra/prod/` must be safe for unattended use in CI:
  fail fast, avoid hidden prompts, and keep behavior explicit.
- Shell scripts should centralize shared logic in `lib.sh` and avoid copy-paste
  drift across deploy/bootstrap flows.
- Gateway, Caddy, and compose config must agree on ports, hostnames, and
  routing responsibilities.
- Infra docs and operator commands must stay aligned with the actual files in
  this directory and the root `justfile`.

## Standards

- Prefer small, composable shell scripts over monolithic orchestration.
- Keep environment handling explicit. If a script depends on a secret or env
  file, that dependency should be obvious from the script or the adjacent doc.
- Make destructive operations obvious in naming and behavior.
- Favor immutable image references and deterministic inputs in deploy paths.
- Keep local, preview, and prod differences intentional and documented rather
  than accidental drift.
- When adding a new service or route, update every affected layer together:
  compose, ingress/gateway config, scripts, and docs.

## Audit Checklist

When auditing `infra/`, check for:

- compose references that no longer match real service names, ports, volumes,
  or env files
- scripts that assume files, directories, or env vars no longer provisioned
- preview/prod drift that looks accidental rather than intentional
- shared runtime concerns duplicated in `preview/compose.yml` or
  `prod/compose.yml` instead of living in `base/compose.yml`
- local dev concerns leaking into `base/compose.yml`, `preview/compose.yml`,
  or `prod/compose.yml`
- ingress config that disagrees with compose topology
- docs or `just` recipes that no longer match the actual operator flow
- duplicated shell logic that should be consolidated in `lib.sh`
- changes that make CI or remote bootstrap interactive or stateful in unsafe
  ways

## Out Of Scope

- Do not rewrite application behavior outside infra-owned contracts.
- Do not broaden production topology casually just because preview already
  runs a service.
- Do not normalize away intentional environment differences without evidence
  they are accidental.
