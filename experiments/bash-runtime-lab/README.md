# Bash Runtime Lab

Experiment for a durable Bash runtime aimed at CI/CD workflows and pipeline
definitions.

## Direction

The current design target is:

- parse Bash into an AST
- treat command invocation boundaries as the default implicit durability units
- execute real host binaries inside an explicit tracked workspace
- journal the workspace and process state after each command
- make replay and caching layer-oriented, similar to container image layers

This is not a line-level cache and it is not primarily a comment-directive DSL.
The runtime should understand real Bash structure first, then attach durability
semantics to the command graph the interpreter already sees.

## Working Model

The easiest way to think about durability right now is:

- each command visit produces a new workspace layer
- the layer is defined by the command identity plus the resulting workspace delta
- replay means restoring or reusing that layer instead of re-running the command
- callers can add manual dependency hashes to force invalidation when upstream
  inputs change

That is close to how Docker image layers feel, with two important differences:

- our boundary is an executable Bash node, not a Dockerfile instruction
- our cache key must include dynamic execution context such as loop iterations,
  branch path, cwd, env, and command inputs

So the analogy is useful, but only if we remember that this runtime is
interpreter-driven rather than build-file-driven.

## Why This Shape

For CI/CD, simulated commands are not enough. We need real tools like:

- `make`
- `prettier`
- `docker`
- language-specific build and test tools

That means the runtime needs two things at once:

- interpreter ownership of Bash structure and command boundaries
- host execution of real binaries inside a controlled workspace

`just-bash` is still useful here, mainly as the parsing and interpreter substrate.
It gives us AST structure and instrumentation points. But the long-term product
value is not in simulating every Unix tool in JS. It is in journaling and
replaying real workflow commands safely enough to be useful.

## Runtime Shape

1. Parse the script into an AST.
2. Assign stable ids to executable command nodes.
3. Track dynamic visit context during execution.
4. Before each command:
   capture workspace and process pre-state.
5. Execute the real command in the tracked workspace.
6. After each command:
   capture stdout, stderr, exit code, env/cwd changes, and workspace diff.
7. Persist a journal entry and resulting workspace layer metadata.

The initial assumption for the experiment is intentionally naive:

- everything meaningful happens inside the tracked workspace
- if we can diff the workspace before and after a command, we have enough signal
  to build a useful first durability model

That assumption is incomplete, but good enough for the first serious prototype.

## Explicit Boundaries

Explicit boundaries may still exist later, but only as overrides:

- group several commands into one cacheable unit
- force reruns
- attach stronger invalidation policy

They should refine the implicit command model, not replace it.

## Repo Status

What this experiment should now optimize for:

- interpreter-backed command journaling
- real host binary execution in a tracked workspace
- layer-like workspace diffs after each command
- replay keys based on node identity plus dynamic execution context

What is no longer the main product direction:

- required comment-based durable block syntax
- line-level caching
- JS-only command simulation as the primary execution mode

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

- [Runtime architecture](./docs/runtime-architecture.md)
- [Implementation plan](./docs/implementation-plan.md)
- [V2 trade-offs](./docs/V2.md)
