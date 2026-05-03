# Agent Substrate

This document describes the internal agent/runtime substrate we want for `red`.

The intent is not to copy Flue or Sandcastle directly. The intent is to borrow
the good parts of both:

- Flue-style packaging for agents and skills
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
- simple repo-native packaging for agents and skills
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
- obvious colocated skills
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
- runtime conventions should be inferred from path and code whenever possible
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

- asset packaging for skills
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
    skills/
      summarize-diff/
        SKILL.md
  triage/
    agent.ts
    skills/
      investigate-failure/
        SKILL.md
  shared/
    skills/
      shell-audit/
        SKILL.md
```

Notes:

- `agent.ts` is the executable entrypoint
- `skills/` stay repo-owned and discoverable
- each agent can have its own local `skills/`
- shared assets can live under `bureau/shared/`
- this packaging is intentionally simple and Bun-friendly
- adjacent assets should be resolvable by relative path
- directory layout should do most of the functional grouping

We do not need to adopt this exact path immediately, but this is the right
mental model.

## Agent Entry Contract

Each agent should expose a single Bun-native entrypoint at:

- `bureau/<agent-name>/agent.ts`

That file should expose a single obvious public agent instance, usually via a
small named factory:

```ts
export function daemonReviewer() {
  return agent<Input>()
    .plan(async (ctx) => {
      // build execution context
      // call shared engine
      // return a plan or output
    })
    .build();
}

export default daemonReviewer();
```

The goal is:

- one obvious entrypoint
- one obvious place for agent-local skills
- no heavy framework runtime required to discover or invoke the agent

This is the main part of Flue's ergonomics that we want to preserve.

## Convention Over Manifest

We should infer as much as possible from packaging conventions:

- the agent entrypoint is always `bureau/<agent-name>/agent.ts`
- the agent name is the folder name
- agent-local skills are adjacent by path

That means the first substrate should not require a separate manifest file.

If we later discover a small amount of metadata is truly needed, it should be
added reluctantly and kept outside the critical local development path.

Do not let a future manifest turn into a framework DSL.
Do not bake sandbox constraints into it.
Do not require agents to predeclare artifacts. Artifact harvesting belongs to
the runtime/execution layer after the agent has run.

## Current Substrate

We should keep the first SDK extremely small and explicit.

The most important parts of the current substrate are:

- named factories like `daemonReviewer()` or `triage()`
  - small wrappers that return agent instances with a uniform `run(...)` method
- `BureauAgentContext<Input, Output>`
  - the Bun-native runtime context passed into every agent
- `PreparedWorkspace`
  - the seeded codebase handoff from the execution backend
- `BureauToolRegistry`
  - runtime tool lookup that stays distinct from packaged skills
- a thin invocation/runtime layer
- repo-backed sandbox preparation
- workflow-owned orchestration for daemon-review

What is intentionally *not* part of the current PR:

- trigger taxonomies
- agent `kind`
- artifact declarations
- default model selection
- the generic `bureau-run` / `bureau-seance` runtime surface

That generic runtime/session layer is tracked separately in:

- issue #50: `Define bureau run/seance runtime and session model`

Those either belong to the outer adapter/runtime or should be discovered from
the sandbox/output after execution.

The intended feel is:

```ts
export function daemonReviewer() {
  return agent<DaemonReviewInput>()
    .plan(async (ctx) => {
      const result = await runSharedEngine({
        workspaceRoot: ctx.workspace.reviewRoot,
        baseRef: ctx.input.baseRef,
        headRef: ctx.input.headRef,
      });

      await ctx.artifacts.writeText("summary.md", result.summaryMarkdown);
      return ctx.output(result);
    })
    .build();
}

export default daemonReviewer();
```

That gives us the Flue-style ergonomics we want:

- one obvious agent entrypoint
- no separate metadata file in the common case
- colocated agent skills by path
- no framework build step required to run it locally under Bun

## Typed Invocation

We should be able to keep the filesystem-first packaging model while still
getting a type-safe SDK for invocation.

The shape we want is something like:

```ts
const result = await bureau.daemonReview({
  input: {
    repoId: "bind/red",
    baseRef: "origin/main",
    headRef: "HEAD",
  },
  // runtime wiring omitted
});
```

Where:

- `bureau.daemonReview(...)` is fully typed
- the `input` payload is specific to that agent
- the `output` is specific to that agent

The runtime can get there without adding framework metadata if we do one of
these:

1. build a typed registry from imported `bureau/*/agent.ts` modules
2. generate a tiny registry file from the filesystem at build/dev time
3. use a Bun-native loader that discovers `agent.ts` files and emits types for
   them into a generated SDK file

The first version should likely be the simplest:

- keep agent packaging convention-only
- generate or hand-maintain a typed registry
- expose a `bureau` runtime object from that registry

That gives us the best of both worlds:

- filesystem as router
- type-safe invocation like `bureau.daemonReview(...)`
- no trigger taxonomy or manifest DSL

## Runtime Inference vs Type Inference

There is a hard boundary here:

- runtime inference can discover agents from the filesystem
- TypeScript type inference needs some static source of truth

So pure runtime discovery can give us:

- `invokeAgent("daemon-review", ctx)`
- dynamic loading from `bureau/<agent>/agent.ts`
- no code generation

But it cannot, by itself, give us fully typed property-style invocation like:

```ts
await bureau.daemonReview(...)
```

For that, we need some static analysis layer somewhere.

### Practical Options

1. pure runtime discovery
   - simplest
   - no codegen
   - weaker ergonomics and weaker property-based types

2. handwritten typed SDK
   - still no build step
   - explicit imports in something like `bureau/sdk.ts`
   - good near-term compromise

3. plugin or generated SDK
   - scans `bureau/*/agent.ts`
   - emits a static typed registry or virtual module
   - gives the best “filesystem as router” plus typed SDK experience

### Best Of Both Worlds

If we eventually want:

- filesystem-first agent discovery
- no framework metadata DSL
- typed `bureau.<agent>(...)` invocation

then a Bun/TypeScript plugin or equivalent generated virtual module is the
cleanest path.

That would let us preserve the packaging conventions while still giving the
compiler a static artifact to type-check against.

We should not start there, but we should document it as the likely long-term
path for the highest-ergonomics developer experience.

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

Agents may need custom runtime tools in addition to skills.

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
- skills

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
  - `bureau/workflows/daemon-review/src/core.ts`
- GitHub adapter:
  - `bureau/workflows/daemon-review/src/github.ts`
- local adapter:
  - `bureau/workflows/daemon-review/src/local.ts`
- local inspect surface:
  - `bureau/workflows/daemon-review/src/local-inspect.ts`

Next mapping step:

- lift the “agent packaging” convention above `bureau/workflows/daemon-review`
- leave the domain engine where it is until another agent needs the same
  substrate

This avoids premature churn.

## Future Work

### Future Triage Agent

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

### Next Steps

1. Keep the current daemon-review runner split as the baseline.
2. Do not re-introduce Flue-specific runtime code into the branch.
3. Standardize the `bureau/<agent>/agent.ts` convention and inference rules.
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
