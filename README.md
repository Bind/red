# redc

`redc` is an agent-native code forge workspace. The repo contains the main API and CLI, supporting services, the web app, infra and compose wiring, shared packages, and a small set of experiments.

## Working from the repo root

Use the root `justfile` as the command runner.

Common commands:

```bash
just
just setup
just up
just down
just test
just typecheck
just verify
./scripts/redc
```

Service-specific commands:

```bash
just git-server-up
just git-server-test
just gs-integration

just auth-install
just auth-serve
just auth-test
just auth-compose-e2e
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
|   |-- obs/
|   |-- ocr/
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

- `apps/ctl/`: main Bun/Hono backend plus the `redc` CLI entrypoint.
  Important subfolders:
  `cli/` for the terminal client, `claw/` for agent-run orchestration and runner design notes, `db/` for schema/query code, `engine/` for review and summary logic, `ingest/` and `jobs/` for processing, and `repo/` for grs integration.
- `apps/auth/`: standalone auth service with Better Auth, session exchange, OAuth endpoints, and compose support.
- `apps/bff/`: backend-for-frontend service.
- `apps/grs/`: git repository server package, including the TypeScript client/test surface in `src/` and the native Zig implementation under `zig/`.
- `apps/obs/`: observability collector service for request-wide events and rollups.
- `apps/ocr/`: OpenCode runner image build context used by the API to launch agent runs in Docker.
- `apps/web/`: Vite/React frontend app.

### `pkg/`

Shared importable code lives here.

- `pkg/obs/`: shared observability package used by multiple apps.

### `infra/`

Infra and local dev wiring.

- `infra/compose/`: root Docker Compose stack used by `just up`, `just down`, and related commands.
- `infra/caddy/`: local gateway/proxy configuration.
- `infra/gateway/`: gateway-specific config and assets.
- `infra/scripts/`: setup and deployment scripts, including the local dev bootstrap path.

### `experiments/`

Self-contained labs, canaries, and technical probes that are not yet part of the main product surface.

- `experiments/README.md`: conventions for what belongs here and how new experiments should be structured.
- Current experiments live under:
  `ci-runner-lab/`, `durable-workflow-lab/`, `git-mirror-canary/`, and `smithers-lab/`.

### `scripts/`

Repo-level helper scripts.

- `scripts/redc`: shell wrapper for the root CLI.

## Documentation setup

The current doc layout is workable, but it should stay opinionated:

- Root `README.md` should explain the repo shape, top-level commands, and where things live.
- App-level `README.md` files should describe runtime surface, commands, and boundaries for a single app.
- `experiments/*/README.md` files should stay local to each experiment.
- Design notes should usually live beside the code they describe rather than in a root-level catch-all folder.

## Notes for contributors

- Prefer `just` commands over ad-hoc shell commands when a recipe already exists.
- Use `.integration.ts` for git-server live integration tests so they stay out of the default `bun test` run.
- Install local hooks with `just hooks-install`.
