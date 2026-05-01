# Agent Substrate

This document describes the internal agent/runtime substrate we want for `red`.

The intent is not to copy Flue or Sandcastle directly. The intent is to borrow
the good parts of both:

- Flue-style packaging for agents, roles, skills, and prompts
- Sandcastle-style isolation and execution backends for code-changing runs
- Bun-native local and CI ergonomics
- no required build step just to test an agent locally

## Why This Exists

We now have a much cleaner daemon-review runner split:

- shared review engine
- GitHub adapter
- local adapter

That refactor was worth doing regardless of framework choice.

The recent Flue spike was useful because it clarified the architectural
boundary we actually care about:

- we like the packaging model
- we do not want Node-first build/runtime constraints
- we do not want framework-specific friction in the inner loop

So the next step is not “adopt Flue.” The next step is to define our own
substrate for packaging and running agents in this repo.

## Goals

- Bun-first local and CI execution
- no bundling requirement for local development or CI invocation
- simple repo-native packaging for agents, roles, prompts, and skills
- one shared runtime model across:
  - GitHub Actions review agents
  - local daemon debugging
  - future triage/background agents
  - future hosted control-plane agent runs
- pluggable execution backends
- structured artifacts, logs, and wide-events across every run
- clear boundaries between:
  - orchestration
  - execution
  - publishing/integration

## Non-Goals

- replacing all existing daemon/runtime code immediately
- introducing a general-purpose framework dependency as the center of gravity
- requiring containers or remote sandboxes for every run
- treating git/worktree orchestration as the only valid execution model
- forcing deploy-time packaging constraints into local development

## Design Principles

### Bun First

All agent entrypoints should run directly under `bun run` in local development
and CI.

That means:

- no mandatory bundle step
- no separate local “framework dev server” just to test an agent
- no runtime model that assumes Node-specific packaging as the default

Deploy-time bundling is acceptable later for hosted surfaces, but it should be
an adapter, not the core development path.

### Package Agents Like Product Code

We want the simplicity of Flue’s packaging model:

- obvious entrypoint
- obvious colocated prompts/roles/skills
- obvious trigger metadata

But we want it in repo-native form.

### Filesystem As Router

One of the best ideas to preserve from Flue is using the filesystem itself as
the primary grouping and routing mechanism for functionality.

That means:

- capabilities are grouped by path before they are grouped by registry
- adjacent files imply relationship
- path layout communicates ownership and composition boundaries
- assets should resolve by path first, not by global registry first

This gives us:

- discoverability
- locality
- low ceremony
- composability

The core principle is:

- the directory structure communicates capability boundaries
- manifests describe runtime requirements
- code resolves adjacent assets by path first

### Tools Are Not Skills

We need to keep a hard distinction between:

- `skills`
  - reusable instruction/workflow bundles
- `tools`
  - executable runtime capabilities exposed to an agent

For daemon review, this distinction matters immediately.

The daemon reviewer uses custom tools like:

- `read`
- `bash`
- `track`
- `complete`

Those are not packaging assets. They are runtime capabilities.

So the substrate must model:

- asset packaging for prompts/roles/skills
- a separate tool registry for executable capabilities

### Separate Outer Harness From Inner Engine

Agent-specific orchestration should be outside the shared business logic.

Examples:

- GitHub review publishing should not live in the shared daemon review engine
- local CLI behavior should not define the inner review semantics
- future triage webhooks should be adapters, not the runtime core

### Execution Backends Must Be Replaceable

We want to support multiple execution modes without rewriting agents:

- local repo
- temp copied workspace
- future isolated workspace/worktree
- future remote/container sandbox

The agent definition should not need to know which backend is active unless it
explicitly requests capabilities.

### Artifacts Are First-Class

Every meaningful run should emit inspectable artifacts:

- summary
- structured outcome
- viewed files
- changed files
- diff/patches
- wide-events
- memory snapshot shape
- session/run id

The current daemon local runner is already moving in this direction and should
be the model.

## What We Liked From Flue

- simple “agent as file” packaging
- a clean distinction between agent entrypoint and runtime invocation
- consistent local/CI/service framing
- explicit trigger metadata
- easy colocating of agent-specific assets

## What We Did Not Like From Flue

- Node-first build/runtime assumptions
- friction when the real runtime is Bun-native
- a bundling step becoming part of the debugging loop
- difficulty importing Bun-specific inner code into the framework’s build path

## What We Liked From Sandcastle

- execution/sandbox isolation as a dedicated concern
- explicit strategy around code-changing runs
- clean way to imagine multiple execution backends

## What We Did Not Like From Sandcastle

- too centered on git/worktree orchestration
- too narrow as a general packaging/runtime model for future non-GitHub agents

## Proposed Repo Shape

We should introduce a first-class repo-owned agent substrate under
`bureau/`.

Why `bureau/`:

- memorable and distinct
- it matches the “where agents live” idea without being overly abstract
- it avoids overloading `.agents/`
- it is not hidden

The packaging should look roughly like this:

```text
bureau/
  daemon-review/
    agent.ts
    agent.json
    prompts/
      review-summary.md
    roles/
      reviewer.md
    skills/
      summarize-diff/
        SKILL.md
  triage/
    agent.ts
    agent.json
    prompts/
      diagnose.md
    roles/
      operator.md
    skills/
      investigate-failure/
        SKILL.md
  shared/
    roles/
      researcher.md
      operator.md
    prompts/
      review-summary.md
    skills/
      shell-audit/
        SKILL.md
```

Notes:

- `agent.ts` is the executable entrypoint
- `agent.json` or frontmatter-backed metadata describes runtime shape
- `roles/`, `prompts/`, and `skills/` stay repo-owned and discoverable
- each agent can have its own local `skills/`, `prompts/`, and `roles/`
- shared assets can live under `bureau/shared/`
- this packaging is intentionally simple and Bun-friendly
- adjacent assets should be resolvable by relative path
- directory layout should do most of the functional grouping

We do not need to adopt this exact path immediately, but this is the right
mental model.

## Agent Entry Contract

Each agent should expose a single Bun-native entrypoint at:

- `bureau/<agent-name>/agent.ts`

That file should feel very close to Flue's `default export` model:

```ts
export default async function agent(ctx: AgentContext<Input, Output>) {
  // parse input
  // build execution context
  // call shared engine
  // return structured output
}
```

The goal is:

- one obvious entrypoint
- one obvious place for agent-local assets
- no heavy framework runtime required to discover or invoke the agent

This is the main part of Flue's ergonomics that we want to preserve.

## Agent Manifest

Each agent should have a small manifest declaring only what orchestration
needs to know.

Possible shape:

```json
{
  "name": "daemon-review",
  "kind": "review",
  "entry": "./agent.ts",
  "triggers": ["github_pr", "local_cli"],
  "defaultModel": "deepseek/deepseek-v4-flash",
  "artifacts": ["summary", "outcome", "patch", "events"]
}
```

This should stay intentionally small.

Do not let the manifest turn into a giant framework DSL.
Do not bake sandbox constraints into the manifest yet.

## Runtime Model

The runtime should have three layers.

### 1. Agent Entry

A thin Bun entrypoint that:

- parses trigger input
- builds the execution context
- calls the shared engine
- returns structured output

### 2. Shared Engine

Owns domain behavior.

For daemon review, that is now:

- plan review
- load memory
- route daemons
- execute them
- produce artifacts
- determine blocking failures

### 3. Adapter

Environment-specific behavior:

- GitHub PR comments / fixup branch publishing
- local stdout + artifact bundle writing
- future triage webhook response
- future control-plane persistence and replay

### 4. Context Builder

Some agents need substantial environment-specific analysis before the actual
agent loop starts.

For daemon review, that includes:

- computing the base/head diff
- loading daemon memory
- routing files
- summarizing relevant repo state
- selecting the specific daemons/files to review

That should be modeled as a first-class layer rather than smuggled into the
agent definition itself.

### 5. Tool Registry

Agents may need custom runtime tools in addition to prompts/skills.

For daemon review, these are already real:

- `read`
- `bash`
- `track`
- `complete`

Future agents may need:

- repo query tools
- artifact readers/writers
- PR publishing tools
- deployment/debug helpers

So the substrate should have an explicit tool registry/injection layer.

## Execution Backend Interface

This is the most important seam for future work.

We should explicitly define an execution backend interface.

For example:

```ts
type ExecutionBackend = {
  prepare(run: PreparedRun): Promise<PreparedExecution>;
  cleanup(execution: PreparedExecution): Promise<void>;
};
```

Or slightly more concrete:

```ts
type ExecutionBackend = {
  createWorkspace(input: {
    trustedRoot: string;
    reviewRoot: string;
    daemonName: string;
    mode: "read_only" | "proposal";
  }): Promise<{
    workspaceRoot: string;
    cleanup(): Promise<void>;
  }>;
};
```

This is the layer where Sandcastle-like ideas shine:

- explicit sandbox creation
- explicit workspace lifecycle
- explicit cleanup
- interchangeable isolation strategies

The current daemon review code effectively already has one concrete backend:

- local temp copied workspace

Future backends could be:

- `local-bash`
- temp copy backend
- `podman`
- isolated worktree backend
- remote/container sandbox backend

This is where Sandcastle-like ideas belong, not at the packaging layer.

## Workspace Provisioning

Some agents, especially daemon-review, need the runtime to seed a sandbox with
code before the agent loop starts.

That source may be:

- the current local checkout
- a temp copied local checkout
- a repo fetched from a different remote
- a trusted base checkout plus a separate review checkout

For daemon-review, the runtime should treat workspace provisioning as a
first-class concern.

A likely shape is:

```ts
type PreparedWorkspace = {
  root: string;
  trustedRoot?: string;
  reviewRoot: string;
  source: {
    kind: "local" | "remote";
    repoId?: string;
    remoteUrl?: string;
    baseRef?: string;
    headRef?: string;
  };
  cleanup(): Promise<void>;
};
```

The important point is not this exact type. The important point is that the
runtime, not the agent file, owns sandbox seeding and cleanup.

## Logging And Observability

Every agent should use the shared logging helper.

Requirements:

- stdout remains usable in local and CI runs
- structured logs flow through LogTape
- wide-events are captured per run
- artifact bundles are written in a consistent layout

This should be standardized once at the substrate layer so future agents do not
each reinvent:

- logger setup
- artifact directory layout
- event persistence
- session metadata emission

## Daemon Review Runtime Shape

`daemon-review` is the clearest example of why the substrate needs multiple
layers.

It does not just need:

- an agent entrypoint
- prompts/skills

It also needs:

- seeded workspace(s)
- pre-run analysis
- daemon memory loading
- routing
- custom review tools

So for daemon-review specifically, the runtime model is:

1. Provision workspace
2. Build review context
3. Inject daemon-review tools
4. Run the shared review engine
5. Publish or persist artifacts via the adapter

That is the model future agents should be able to reuse in simpler or more
complex forms.

## How Daemon Review Maps Onto This

Daemon review should be the first consumer of the substrate, not the only one.

Current mapping:

- shared engine:
  - `workflows/daemon-review/src/core.ts`
- GitHub adapter:
  - `workflows/daemon-review/src/github.ts`
- local adapter:
  - `workflows/daemon-review/src/local.ts`
- local inspect surface:
  - `workflows/daemon-review/src/local-inspect.ts`

Next mapping step:

- lift the “agent packaging” convention above `workflows/daemon-review`
- leave the domain engine where it is until another agent needs the same
  substrate

This avoids premature churn.

## Future Triage Agent

The triage agent is the main reason to design this as a substrate, not a
GitHub-review-only workflow.

A future triage agent likely needs:

- non-GitHub trigger surfaces
- background execution
- durable artifacts
- the same logging and event capture
- different execution backend constraints

That makes the packaging/runtime layer more important than any one review
workflow.

## Immediate Next Steps

1. Keep the current daemon-review runner split as the baseline.
2. Do not re-introduce Flue-specific runtime code into the branch.
3. Define a small repo-owned agent manifest.
4. Extract an explicit execution backend interface from daemon-review.
5. Make daemon-review the first consumer of that substrate.
6. Only after that, evaluate whether a triage agent should share the same
   outer packaging directly.

## Decision

For now:

- keep the current Bun-native runner architecture
- borrow the packaging ideas from Flue
- borrow execution-backend ideas from Sandcastle
- build our own thin substrate around those ideas

That gives us the control we want without losing the simplicity that made the
framework experiments attractive in the first place.
