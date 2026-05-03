# Bureau Agents Guide

This directory owns the bureau runtime surface: workflow observation, agent
run wrappers, sandbox lifecycle emission, and the daemon-review orchestration
that ties those pieces together.

Changes here are risky because the code is small but cross-cutting. A local
rename or event-shape tweak can break workflow joins, artifact readers, or
daemon execution history without touching the broader app stack.

## Progressive Disclosure

- start from the narrowest relevant file:
  `observability.ts`, `agent-runtime.ts`, `sandbox.ts`, or
  `workflows/daemon-review/workflow.ts`
- pull in `workflows/daemon-review/src/local.ts` when validating local artifact
  output
- pull in `pkg/daemons/src/run-history.ts` and `pkg/daemons/src/wide-events.ts`
  only when validating persisted event shape or wide-event expectations
- do not read the rest of the repo by default

## Core Invariants

- `observability.ts` owns workflow-level event emission and the canonical
  workflow join key
- `agent-runtime.ts` must preserve the workflow join key on agent events
- `sandbox.ts` emits sandbox lifecycle events through the shared observer
- `workflows/daemon-review/workflow.ts` is the main assembly point for bureau
  workflow, agent, and sandbox observability
- local artifact writers should persist the same workflow identifier exposed by
  the emitted workflow events

## Audit Checklist

- workflow and agent events must share the same workflow join key
- docs under `bureau/` must name the same source-of-truth files the code uses
- workflow step, agent, and sandbox event responsibilities should stay distinct
- document examples should not drift from the actual default event kinds or
  artifact outputs
