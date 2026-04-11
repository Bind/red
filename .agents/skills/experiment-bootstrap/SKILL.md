---
name: experiment-bootstrap
description: Bootstrap new repo experiments with the redc conventions for folder layout, runtime config, testing, and compose-based e2e.
---

# Experiment Bootstrap

Use this skill when starting a new experiment under `experiments/`, or when
standardizing an existing one onto the repo's experiment conventions.

## Workflow

1. Create the experiment under `experiments/<name>/`.
2. Use a thin root with `src/`, `compose/`, `README.md`, `Dockerfile`, `docker-compose.yml`, `package.json`, `tsconfig.json`, and a local `bun.lock`.
3. Keep source layout singular:
   - `src/service/` for runtime services and adapters
   - `src/store/` for persistence abstractions
   - `src/util/` for config, errors, and shared types
   - `src/test/` for tests and fixtures
4. Keep HTTP routes thin; push behavior into services.
5. Use Hono for web routes, Bun for runtime, Biome for lint/format, and `just` for commands.
6. Make Compose strict: explicit env vars, fail-fast startup, and health checks that wait for readiness.
7. Prefer test-only fixtures over test-only state mutation routes. Delivery sinks may be fake; lifecycle transitions should be service-driven.
8. Verify the experiment with typecheck, tests, and compose E2E before calling it ready.

## Conventions

Read [the experiment checklist](references/experiment-checklist.md) before scaffolding
or refactoring an experiment.
