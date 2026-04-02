# Agent Runtime Interface

This is the target product-facing contract for the next runner implementation.

## Goals

- The app integrates with a structured runtime, not Claw CLI side effects.
- The runtime emits first-class events instead of forcing the app to parse rollout JSONL.
- The runtime returns validated structured output separately from the event stream.
- The app can swap Docker/Claw CLI internals without changing worker or UI contracts.

## Core contract

The interface lives in [src/claw/runtime.ts](/Users/db/workspace/redc/src/claw/runtime.ts).

Key concepts:

- `AgentRuntimeRunRequest`
  - identity: `runId`, `jobName`, `jobId`, `changeId`, `workerId`
  - workspace: `repo`, `headRef`, `baseRef`, `setupScript`
  - prompt provenance: `actionId`, `promptName`, `promptHash`, `instructions`
  - output contract: expected JSON/files and host-side validator

- `AgentRuntime`
  - `startRun(request)` returns an `AgentRuntimeSession`

- `AgentRuntimeSession`
  - `events`: `AsyncIterable<AgentRuntimeEvent>`
  - `result()`: resolves to final structured result
  - `cancel()`: optional cancellation hook

- `AgentRuntimeEvent`
  - `session.started`
  - `status.updated`
  - `message`
  - `step.started`
  - `step.completed`
  - `artifact.available`
  - `result.completed`
  - `session.completed`
  - `session.failed`

## Integration direction

The worker should eventually depend on this interface rather than:

- Docker process management
- `codex exec --json`
- rollout file discovery
- `stdout`/`stderr` parsing
- `rolloutPath` heuristics

The current action/prompt system should remain unchanged:

- action ids from `src/claw/actions.ts`
- prompt files in `src/claw/prompts/`
- provenance metadata in summary events

## Expected cutover

1. Add a concrete implementation of `AgentRuntime` for the new runner.
2. Adapt `ClawSummaryGenerator` to call `AgentRuntime` instead of `DockerClawRunner`.
3. Map structured runtime events into existing session/log bus behavior.
4. Remove rollout JSONL-specific plumbing listed in `docs/claw-jsonl-cutover.md`.
