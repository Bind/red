# Bureau Observability Stack

This document describes the bureau observability stack as it works out of the
box in this repo today.

The core shape is:

1. `bureau/observability.ts`
   Creates the workflow observer. It emits workflow-level wide events,
   attaches the canonical `workflowRunId`, buffers events in memory, and sends
   them to `stdout` by default unless a caller overrides the sinks.
2. `bureau/agent-runtime.ts`
   Wraps provider execution in `runAgent()`. It turns provider turn hooks into
   `agent.run.*`, `agent.turn.*`, and `agent.tool.called` wide events, while
   preserving `workflowRunId` and `workflowName` when the agent is running
   inside a workflow observer.
3. `bureau/sandbox.ts`
   Emits `sandbox.*` lifecycle events from the sandbox provider itself. That
   keeps sandbox creation, clone, preserve, cleanup, and clone-failure facts on
   the same workflow event stream as the higher-level workflow steps.
4. `bureau/workflows/daemon-review/workflow.ts`
   Assembles the main workflow. It starts the observer, wraps major phases in
   `observer.step(...)`, passes the observer into sandbox creation and daemon
   execution, then returns the drained workflow-wide event buffer as the
   workflow artifact stream.
5. `bureau/workflows/daemon-review/src/local.ts`
   Persists local artifact bundles. `artifacts.json` carries the workflow
   metadata, `workflow-events.jsonl` carries the workflow-wide event stream, and
   per-daemon outcome files persist the daemon-specific outputs.

## Default Event Layers

Out of the box, bureau emits three distinct layers of wide events:

- `workflow.run.*` and `workflow.step.*` from `observability.ts`
- `agent.run.*`, `agent.turn.*`, `agent.tool.called`, and `agent.finding`
  from `agent-runtime.ts` plus daemon execution
- `sandbox.*` from `sandbox.ts`

These layers should stay separate. Workflow events describe orchestration.
Agent events describe model/provider execution. Sandbox events describe
workspace lifecycle.

## Join Keys

The canonical join key for all workflow-scoped bureau events is
`workflowRunId`.

- workflow events emit `workflowRunId` directly from the observer
- agent events inherit the same `workflowRunId` from the observer
- sandbox events inherit the same `workflowRunId` because they emit through the
  observer
- local workflow artifacts persist that same `workflowRunId`

If this contract changes, update the code and this document together. Mixed
surfaces such as workflow events using `runId` while agent events use
`workflowRunId` are drift and should be treated as a bug.

## Source Of Truth

When auditing or extending this surface, read these files in order:

1. `bureau/observability.ts`
2. `bureau/agent-runtime.ts`
3. `bureau/sandbox.ts`
4. `bureau/workflows/daemon-review/workflow.ts`
5. `bureau/workflows/daemon-review/src/local.ts`

Pull in tests only after the contract is clear from the implementation:

- `bureau/observability.test.ts`
- `bureau/agent-runtime.test.ts`
- `bureau/sandbox.test.ts`

## Current Scope

This document is intentionally narrow. It covers the bureau-local workflow
observability path only. It does not describe:

- the broader `pkg/daemons` standalone runner event contract
- obs ingestion or rollup behavior under `apps/obs/`
- Smithers, Claw, or other non-bureau workflow runtimes
