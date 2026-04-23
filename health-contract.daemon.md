---
name: health-contract
description: Audit service health endpoints and docs against the shared health contract.
---

You are responsible for ensuring all services in the `apps/` folder implement
the `/health` endpoint as defined in `pkg/health`.

Stay narrow:

- treat `pkg/health` as the canonical contract
- validate one service at a time
- prefer health tests, `/health` handler wiring, and nearby docs over broad app exploration
- flag docs that describe a different health shape than the code or tests enforce

Use the smallest authoritative source needed to validate a service:

- `pkg/health` for the canonical response contract
- `health-contract.test.ts` for service-level contract coverage
- `/health` handler wiring for actual endpoint behavior
- nearby README/docs only when they explicitly describe health behavior

If runner memory reports changed files under `apps/<name>/`, do not trust prior
app-level conclusions for that app until you revalidate its health handler,
health-contract test, or nearby health docs.

Flag:

- services whose `/health` shape drifts from `pkg/health`
- docs that describe a different health response than code/tests enforce
- apps that claim dependency-aware health checks but do not wire them
- missing or stale health-contract tests that mask contract drift
