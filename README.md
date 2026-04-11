# redc

`redc` is an agent-native code forge workspace. This repository contains the main API and CLI, supporting services, a web UI, infra and compose setup, and a set of experiments that are being promoted into the main product over time.

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

Git server commands:

```bash
just git-server-up
just git-server-test
just gs-integration
```

Auth service commands:

```bash
just auth-install
just auth-serve
just auth-test
just auth-compose-e2e
```

## Project structure

```text
.
|-- apps/
|   |-- api/
|   |-- auth/
|   |-- bff/
|   |-- gs/
|   |-- observability/
|   |-- web/
|   `-- wide-events/
|-- docs/
|-- experiments/
|-- infra/
|-- pkg/
|   `-- obs/
|-- packages/
|-- scripts/
|-- tools/
|   `-- claw-runner/
|-- web/
|-- justfile
`-- package.json
```

### `apps/`

Product and service code lives here.

- `apps/api/`: main Bun/Hono backend plus the `redc` CLI entrypoint. Notable folders include:
  - `cli/` for the terminal client exposed by `./scripts/redc`
  - `claw/` for agent run orchestration and artifact handling
  - `db/` for schema and query code
  - `engine/` for review, policy, state-machine, and summary logic
  - `ingest/` and `jobs/` for background processing
  - `repo/` for repository-provider and git-server integration code
- `apps/auth/`: standalone auth service with Better Auth, session exchange, OAuth endpoints, compose support, and its own tests.
- `apps/bff/`: lightweight backend-for-frontend service.
- `apps/gs/`: git server package. This includes the TypeScript client/test surface in `src/` and the native Zig implementation under `zig/`.
- `apps/observability/`: reserved app area for observability-facing code. The directory exists, but it is currently much lighter than the other apps.
- `apps/web/`: frontend app built with Vite/React. Most UI code is under `src/routes`, `src/components`, `src/lib`, and `src/hooks`.
- `apps/wide-events/`: dedicated wide-events collector service that stores raw events and request rollups.

### `experiments/`

Incubation area for ideas that are not yet folded into the main product.

- `experiments/ci-runner-lab/`: CI runner prototype with its own compose setup and docs.
- `experiments/durable-workflow-lab/`: workflow durability exploration.
- `experiments/git-mirror-canary/`: git mirror canary service.
- `experiments/smithers-lab/`: agent orchestration lab with workflows and compose fixtures.
- `experiments/README.md`: overview for the experiments area.

### `infra/`

Local and deployment infrastructure support.

- `infra/compose/`: root Docker Compose stack used by `just up`, `just down`, and related commands.
- `infra/caddy/`: local gateway/proxy configuration.
- `infra/gateway/`: gateway-specific config and assets.
- `infra/scripts/`: setup and deployment scripts, including the local dev bootstrap path.

### `pkg/` and `packages/`

- `pkg/obs/`: shared TypeScript observability package used by multiple apps.
- `packages/`: currently present as a top-level directory but not populated like `pkg/`.

### `scripts/`

Small repo-level helpers. The main one to know is:

- `scripts/redc`: shell wrapper that exposes the root CLI and prints available `redc` commands.

### `tools/`

Tooling that supports the main services.

- `tools/claw-runner/`: containerized runner used for agent execution flows.

### Other top-level files and folders

- `justfile`: primary command entrypoint for local development.
- `package.json`: workspace definition for the Bun monorepo.
- `docs/`: additional project documentation.
- `web/`: separate top-level web workspace/assets area that exists alongside `apps/web`.
- `sst.config.ts`: SST configuration for cloud/deploy infrastructure.

## Notes for contributors

- Prefer `just` commands over ad-hoc shell commands when a recipe already exists.
- Use `.integration.ts` for git-server live integration tests so they stay out of the default `bun test` run.
- Install local hooks with `just hooks-install`.
