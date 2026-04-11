# Experiment Checklist

Use this when bootstrapping or tightening a new `experiments/<name>` package.

## Layout

- Keep the experiment self-contained.
- Prefer `src/service/`, `src/store/`, `src/util/`, and `src/test/`.
- Put test helpers under `src/test/helpers/`.
- Keep DB wiring under `src/service/db/`.

## Runtime

- Use Bun as the runtime.
- Use Hono for HTTP services.
- Keep routes thin.
- Put lifecycle logic in services.
- Put persistence behind stores.

## Config

- Use separate dev and compose launch paths.
- Dev may use local defaults.
- Compose must fail fast with explicit env vars.
- Do not silently fall back in Compose.

## Testing

- Add in-process tests first.
- Add compose E2E for meaningful integration coverage.
- Prefer real protocol flows over direct state patching.
- Keep fake layers limited to delivery sinks and similar fixtures.

## Tooling

- Use Biome for lint and format.
- Use `just` as the command runner.
- Add README usage notes only for what is actually supported.
