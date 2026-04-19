# Auth coverage

Tracking doc for endpoints that need auth but don't have it today. Captured
from the audit on 2026-04-18; revisit before the next production push.

## Critical — unauthenticated write endpoints

| service | endpoint | what it does | file ref | recommended auth |
|---|---|---|---|---|
| ctl | `POST /api/ingest/ref-update` | Webhook: creates a change from a ref push, triggers agent jobs | `apps/ctl/index.ts:192` | bearer shared-secret (webhook callers) |
| ctl | `POST /api/repos` | Creates a repo | `apps/ctl/index.ts:425` | session + admin |
| ctl | `POST /api/changes/:id/regenerate-summary` | Enqueues agent job | `apps/ctl/index.ts:283` | session |
| ctl | `POST /api/changes/:id/requeue-summary` | Enqueues agent job | `apps/ctl/index.ts:310` | session |
| obs | `POST /v1/events` | Ingests wide events | `apps/obs/src/service/app.ts:23` | service-to-service shared-secret |
| triage | `POST /v1/runs` | Creates a triage run | `apps/triage/src/app.ts:16` | service-to-service shared-secret |
| triage | `POST /v1/runs/:id/approve` | Runs the code-generation phase | `apps/triage/src/app.ts:34` | session (human-in-the-loop gate) |
| triage | `POST /v1/runs/:id/reject` | Cancels | `apps/triage/src/app.ts:44` | session |
| bff | `GET /rpc/dev/magic-link` | Exposes the last email sent (dev only) | `apps/bff/src/app.ts` | env-gate + admin-only, or delete |

## Medium — 20+ unauthenticated read endpoints on ctl

Every `GET /api/...` handler on `apps/ctl/index.ts` runs without auth.
Examples: `/api/velocity`, `/api/review`, `/api/repos`, `/api/repos/:owner/:repo`,
`/api/repos/:owner/:repo/{file,branches,commits,commits/:sha/diff}`,
`/api/changes/:id`, `/api/changes/:id/diff`, `/api/changes/:id/sessions`,
`/api/changes/:id/agent-events` (SSE), `/api/changes/:id/logs` (SSE),
`/api/sessions/:id/events`, `/api/jobs/pending`, `/api/branches`,
`/api/claw/actions*`, `/api/claw/runs*`.

**Key question before deciding:** is ctl reachable from the public internet,
or only internally with bff in front? If only internal, these are fine and
the audit stops here. If public, they leak repo contents, diffs, and agent
session transcripts; we should require session auth matching the bff
`/rpc/*` shape.

## Already correct

- **apps/auth** — OAuth2 endpoints use HTTP basic; session-bearing routes
  verify Better Auth cookies; test mailbox is env-gated via
  `exposeTestMailbox`.
- **apps/grs** — HMAC-signed bearer tokens plus basic auth; every route
  passes through `authorizeRequest` in `apps/grs/zig/src/redc_auth.zig`.
- **apps/bff** `/rpc/*` — session → JWT exchange, uses cookies.

## Suggested sequencing when we come back

1. **obs ↔ triage shared secret.** Internal only, smallest blast radius, one
   env var on each side plus a header check. Cheapest win.
2. **ctl `POST /api/ingest/ref-update`.** Single shared secret, standard
   webhook convention. Same pattern as #1.
3. **Confirm ctl's network exposure.** This decides whether the 20+ read
   endpoints are a real gap or an artifact of internal-only deployment.
4. **ctl `POST /api/repos` + the two summary endpoints.** Require the same
   session flow bff already does.
5. **bff dev endpoints.** Env-gate `/rpc/dev/magic-link` so prod builds
   can't serve it.

## Shared infrastructure this will want

Once we start adding the above, the repeating middleware (shared-secret
check, session→JWT exchange, JWKS verification) is the natural first
consumer of a `pkg/server` helper library. That refactor is separately
tracked — this doc is intentionally scope-limited to the auth gaps.
