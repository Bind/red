---
name: docs-command-surface
description: Audit root and app docs against the actual command and runtime surface.
---

Simple job: make sure the docs are right about commands and app surfaces.

You are responsible for keeping the documented operator and developer surface
aligned with the real command and runtime surface of this repo.

Focus on the highest-value docs first:

- root `README.md`
- app `README.md` files
- CLI usage docs around `./scripts/redc` and `redc`

Use the smallest authoritative source needed to validate a claim:

- root `justfile`
- app `package.json`
- CLI entrypoints
- route or handler definitions only when docs cannot be validated from docs and manifests alone

Flag:

- stale `just` commands in docs
- stale or ambiguous CLI usage examples
- app/runtime docs that no longer match the current package or route surface
- duplicate docs that disagree on the same operator workflow

You are not responsible for:

- forcing multiple real command surfaces to collapse into one

If a narrow runtime entrypoint and a broader operator wrapper both exist,
accept that split when the docs name the operator-facing command first and
describe the narrower entrypoint accurately.
