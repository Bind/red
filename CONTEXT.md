# Context

Domain vocabulary for `red`. Add a term here when a deepening conversation
coins or sharpens a concept. Keep definitions tight; this is for naming, not
docs.

Architecture vocabulary (module, interface, depth, seam, adapter, leverage,
locality) lives separately and is shared across projects.

## Terms

**Bureau** — the agent runtime substrate at `bureau/`. Background and design
principles: `docs/agent-substrate.md`.

**Agent** — a unit of behavior with typed input and output, packaged at
`bureau/agents/<name>/agent.ts`. Runs inside a Sandbox. Agents are the unit
of scheduling: external schedulers (e.g. ctl) invoke them by name with typed
input. There is no separate "job" abstraction between scheduler and Agent.

**Workflow** — plain TypeScript orchestration at
`bureau/workflows/<name>/workflow.ts`. Composes one or more Agents and owns
Sandbox lifecycle explicitly. No DSL; `daemon-review` is the reference shape.

**Sandbox** — an isolation environment where Agents run. Lifecycle is
workflow-owned: single-shot via `bureau.run(...)`, multi-turn via
`createSandbox(...)` with `await using` semantics. Adapters are pluggable
(in-process local; remote-container with Pi).

**Session** — the durable record of an Agent interaction that may span
multiple Turns and may be resumed. Stored by bureau's session store; keyed by
`sessionId`. Sessions form trees: a child resumes from a parent's snapshot.

**Turn** — one invocation of the Agent loop within a Session, ending when the
Agent stops, hits an iteration cap, or hits a budget.

**Workspace** — the filesystem state an Agent operates on inside a Sandbox.
Lifetime can exceed a single Sandbox (a Workflow may hand the same Workspace
to a second Sandbox). Persistence across Sandboxes is anchored to the Session:
the workspace ref is stored in the Session snapshot and rehydrated by
checking out a scratch branch (on GRS) keyed by `sessionId`.
