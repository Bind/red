# Bash Runtime Lab

Experiment for a durable Bash runtime with implicit cache and resume boundaries.

## Direction

The current repo contains an initial directive-based prototype, but that is no
longer the target UX.

The intended direction is:

- start from a full Bash interpreter substrate, closer to
  [`vercel-labs/just-bash`](https://github.com/vercel-labs/just-bash)
- treat command invocation boundaries as the default durable/cacheable unit
- journal command output and state transitions between invocations
- keep explicit chunk boundaries as an optional escape hatch, not the main model

This is a better fit for Bash authoring because durability should attach to the
script structure the interpreter already understands, not to a second DSL layered
on top with comment directives.

## Why This Direction

`just-bash` already proves several pieces we want in the base runtime:

- a TypeScript Bash interpreter
- AST parsing and transform support
- isolated execution semantics
- a filesystem abstraction we can instrument

The important difference for this lab is the durability layer. We do not want to
cache by source line. We want the runtime to reason over executable Bash nodes:

- simple commands
- pipelines
- boolean lists (`&&`, `||`)
- compound bodies when needed for control-flow safety

That points toward AST-node journaling with runtime hooks around command
dispatch.

## Current Hypothesis

Default durable boundaries should be implicit and command-oriented:

- each command invocation gets a stable node identity from the parsed script
- each runtime visit gets a dynamic execution path
- the runtime records stdout, stderr, exit status, env changes, cwd changes, and
  filesystem writes
- resumability replays prior results when the invocation identity and inputs are
  compatible

Examples of dynamic execution path components:

- function stack
- loop iteration index
- branch path
- subshell nesting

That is the minimum needed to distinguish:

- the same `echo` inside two different branches
- the same `curl` inside separate loop iterations
- a function body called from two call sites

## Explicit Boundaries

Explicit boundaries are still useful, but as hints or overrides:

- group several commands into one durable transaction
- mark a region as always rerun
- attach stronger invalidation rules

They should refine the implicit model, not replace it.

## Implementation Stages

1. Interpreter-first
   Use a full Bash interpreter and expose hooks before and after command
   invocation.
2. Journal-first durability
   Persist command journals, state snapshots, and replay metadata.
3. Policy layer
   Add cacheability rules, explicit durability hints, and invalidation controls.

## Repo Status

What exists today:

- a Bun/Hono experiment package under `experiments/bash-runtime-lab`
- tests and HTTP surface for run execution and inspection
- a first-pass explicit durable-block prototype

What should happen next:

- replace the directive-driven runtime core with an interpreter-backed one
- move caching from explicit blocks to executable AST nodes
- instrument command dispatch and filesystem mutation tracking

## Run

```bash
cd experiments/bash-runtime-lab
just install
just serve
```

## Verify

```bash
cd experiments/bash-runtime-lab
just typecheck
just test
BASH_RUNTIME_LAB_HOST_DATA_DIR="$(pwd)/.tmp-compose-data" just compose-e2e
```

## Design Notes

- [Implicit durability architecture](./docs/implicit-durability-architecture.md)
