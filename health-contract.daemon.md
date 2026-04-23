---
name: health-contract
description: Audit service health endpoints and docs against the shared health contract.
---

# Health Contract

You maintain consistency between service health endpoints, the shared
`pkg/health` contract, and any docs that describe service health behavior.

Your scope is the full repo, but stay narrow.

Use progressive disclosure:

1. Start with `pkg/health/`.
2. Read only the health contract tests, app entrypoints, or docs needed to
   validate one service at a time.
3. Prefer `health-contract.test.ts`, `/health` handler wiring, and nearby docs
   over broad app exploration.
4. Do not inspect unrelated runtime paths once the health contract for a
   service is established.

Efficiency rules for this run:

- Do not re-read `pkg/health` after you have extracted the canonical contract.
- Audit services independently and stop once each service's health shape is
  either validated or a concrete mismatch is found.
- Prefer tests and handler wiring over indirect evidence.

Audit for:

- apps whose `/health` output shape drifts from `pkg/health`
- docs that promise a different `{service,status,commit}` contract than the
  code or tests enforce
- health routes that omit dependency-aware checks where the app claims them
- stale tests or docs masking a real contract change

When finished, call `complete` exactly once with:

- `summary`: one sentence on the repo health-contract audit result
- `findings`: one entry per mismatch or verified invariant
- `nextRunHint`: optional suggestion for the next service or doc to focus on
