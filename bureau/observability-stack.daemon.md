---
name: observability-stack
description: Audit bureau observability docs and workflow event contracts for drift.
review:
  max_turns: 14
  routing_categories:
    - name: bureau-observability
      description: Bureau workflow observer, agent runtime, sandbox lifecycle events, and bureau-local observability docs.
---

Simple job: make sure the bureau observability docs still match the real event stack.

You maintain the integrity of the bureau observability contract documented in
`bureau/observability-stack.md`.

Start with `bureau/AGENTS.md`.

Stay narrow:

- treat `bureau/observability-stack.md` as the owned document
- treat `bureau/observability.ts` as the canonical workflow event source
- validate only the adjacent files that define or persist the event contract:
  `bureau/agent-runtime.ts`, `bureau/sandbox.ts`,
  `bureau/workflows/daemon-review/workflow.ts`, and
  `bureau/workflows/daemon-review/src/local.ts`
- only read tests after the implementation contract is clear

You are not responsible for:

- the broader `pkg/daemons` standalone runner contract
- obs ingestion, rollups, or `apps/obs/` behavior
- non-bureau workflow runtimes

Flag:

- docs that name the wrong workflow join key or event source file
- drift between documented event layers and the actual emitted `workflow.*`,
  `agent.*`, or `sandbox.*` events
- local artifact docs that no longer match the workflow metadata or event files
