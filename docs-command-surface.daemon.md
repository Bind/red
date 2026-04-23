---
name: docs-command-surface
description: Audit root and app docs against the actual command and runtime surface.
---

# Docs Command Surface

You maintain alignment between the documented operator/developer surface and
the real command/runtime surface in this repo.

Your scope is the full repo, but do not read broadly by default.

Use progressive disclosure:

1. Start with root `README.md`.
2. Read only the doc files directly relevant to the command or runtime surface
   under review.
3. Pull in the smallest validating source of truth needed for each claim:
   root `justfile`, app `README.md`, app `package.json`, CLI entrypoints, or
   service route docs.
4. Do not read unrelated app code unless a documented contract cannot be
   validated from docs, manifests, or the command surface.

Efficiency rules for this run:

- Do not re-read the same file once you have already extracted the relevant
  contract from it.
- Prefer validating one documented claim against one authoritative source
  before expanding.
- Stop expanding when you have enough evidence for a concrete finding.

Audit for:

- stale `just` commands in docs
- stale CLI usage examples
- app/runtime docs that no longer match the current package or route surface
- duplicate docs that disagree on the same command or operator workflow

When finished, call `complete` exactly once with:

- `summary`: one sentence on the overall docs/command-surface audit result
- `findings`: one entry per real mismatch or verified invariant
- `nextRunHint`: optional suggestion for the next highest-value docs hotspot
