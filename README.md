# redc

`redc` is an agent-native code forge workspace. The repo contains the main API and CLI, supporting services, the web app, infra and compose wiring, shared packages, and a small set of experiments.

## Working from the repo root

Use the root `justfile` as the command runner.

Common commands:

```bash
just
just setp
just up
just down
just test
just typechek
just check
# broader operator shell CLI
./scripts/redc help
```

Service-specific commands:

```bash
just git-server-up
just git-server-test
just git-server-zig-check
just gs-integratio

just auth-install
just auth-serve
just auth-test
just auth-lint
just auth-format
just auth-compose-e2e

just obs-install
just obs-serve
just obs-replay
just obs-test
just obs-typecheck
just obs-lint
just obs-format

just triage-up
just triage-down
just triage-logs
just triage-test
```

## Container glossary

The local compose stack uses short container names:

- `ctl`: control plane API and CLI backend.
- `grs`: git repository server.
- `obs`: observability collector and rollup service.
- `ocr`: OpenCode runner image name used by `ctl` for agent jobs. This is not a standalone compose service in the dev stack.
- `bff`: backend-for-frontend service.
- `web`: frontend app.
- `auth`: authentication service.
- `db-auth`: auth service Postgres database.
- `s3`: MinIO-based object store used as the local S3 endpoint.
- `init`: system-wide initialization container. Put shared stack bootstrap logic here, such as bucket creation or other one-time infra setup.

## Project structure

```text
.
|-- apps/
|   |-- ctl/
|   |-- auth/
|   |-- bff/
|   |-- grs/
|   |-- mcp/
|   |-- obs/
|   |-- ocr/
|   |-- triage/
|   `-- web/
|-- experiments/
|-- infra/
|-- pkg/
|   `-- obs/
|-- scripts/
|-- justfile
`-- package.json
```

### `apps/`

Main product and runtime surfaces live here.

- `apps/ctl/`: main Bun/Hono backend plus the `redc` CLI entrypoints.
  Important subfolders:
  `cli/` for the narrow Bun status client exposed as the package `redc` bin, `cli/shell/` for the broader operator shell CLI wrapped by `./scripts/redc`, `claw/` for agent-run orchestration and runner design notes, `db/` for schema/query code, `engine/` for review and summary logic, and `repo/` for grs integration.
- `apps/auth/`: standalone auth service with Better Auth, session exchange, OAuth endpoints, and compose support.
- `apps/bff/`: backend-for-frontend service.
- `apps/grs/`: git repository server package, including the TypeScript client/test surface in `src/` and the native Zig implementation under `zig/`.
- `apps/mcp/`: MCP service surface with auth-protected tool access.
- `apps/obs/`: observability collector service for request-wide events and rollups.
- `apps/ocr/`: OpenCode runner image build context used by the API to launch agent runs in Docker.
- `apps/triage/`: triage service plus optional Smithers-backed workflow runner mode.
- `apps/web/`: Vite/React frontend app.

### `pkg/`

Shared importable code lives here.

- `pkg/obs/`: shared observability package used by multiple apps.

### `infra/`

Infra and local dev wiring.

- `infra/base/`: shared runtime/build plumbing used by preview and prod, including the shared compose layer and reusable shell helpers.
- `infra/platform/`: machine-facing ingress/bootstrap assets such as Caddy, gateway, and Packer.
- `infra/dev/`, `infra/preview/`, `infra/prod/`: environment-specific overlays and lifecycle scripts.
- `infra/platform/caddy/`: local gateway/proxy configuration.
- `infra/platform/gateway/`: gateway-specific config and assets.

### `experiments/`

Self-contained labs, canaries, and technical probes that are not yet part of the main product surface.

- `experiments/README.md`: conventions for what belongs here and how new experiments should be structured.
- Current experiments live under:
  `ci-runner-lab/`, `durable-workflow-lab/`, and `smithers-lab/`.

### `scripts/`

Repo-level helper scripts.

- `scripts/redc`: the canonical operator-facing `redc` command; wraps the broader shell CLI under `apps/ctl/cli/shell/`.
- installed `redc`: the narrower Bun CLI from `apps/ctl/cli/index.ts`, currently documenting `status` plus `--api-url` and `--format`.

## Documentation setup

The current doc layout is workable, but it should stay opinionated:

- Root `README.md` should explain the repo shape, top-level commands, and where things live.
- App-level `README.md` files should describe runtime surface, commands, and boundaries for a single app.
- `experiments/*/README.md` files should stay local to each experiment.
- Design notes should usually live beside the code they describe rather than in a root-level catch-all folder.
- When a command has both a narrow runtime entrypoint and a broader operator wrapper, docs should name the operator-facing entrypoint first.

## Notes for contributors

- Prefer `just` commands over ad-hoc shell commands when a recipe already exists.
- Use `.integration.ts` for git-server live integration tests so they stay out of the default `bun test` run.
- `./scripts/redc` is the operator-facing CLI from the repo root (`changes`, `change`, `diff`, `approve`, `regenerate-summary`, `requeue-summary`, `retry-merge`, `repos`, `branches`, `create-pr`, `velocity`, `health`, `jobs`, `actions`, `runs`, `run`, `sessions`, `events`).
- The installed package bin `redc` is the narrower Bun status client (`redc status`, `help`, `--api-url`, `--format`).
- Install local hooks with `just hooks-install`.
