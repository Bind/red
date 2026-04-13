# Runtime Architecture

Design note for the current `bash-runtime-lab` direction.

## Decision

The durable/cacheable unit should default to an executable Bash command visit.

That means:

- the script is parsed into an AST
- executable nodes receive stable identities
- runtime visits receive dynamic identities
- each command produces a journal entry and a workspace layer

The runtime should support real host binaries from the start, assuming an
explicit tracked workspace is the primary state surface.

## Docker Layer Analogy

Thinking about durability like Docker image layers is directionally correct.

The analogy works because both systems:

- apply stepwise mutations to a filesystem state
- persist intermediate results
- reuse prior work when the inputs match

The analogy breaks if taken too literally.

Differences from Docker:

- our boundary is a Bash command visit, not a Dockerfile instruction
- our cache key depends on dynamic execution path, not only source order
- our runtime also cares about stdout, stderr, exit status, cwd, and env
- not all commands are build-like; some have effects outside the workspace

So the right mental model is:

- Docker-style layers for workspace state
- Bash-interpreter semantics for deciding where those layers begin and end

## Core Model

### 1. Parse Once

Parse the full Bash script into an AST and retain source positions for all
executable nodes.

Primary node types:

- simple commands
- pipelines
- boolean lists
- function calls
- loop bodies
- subshells and groups

The first replay boundary should usually be the simple command visit. Higher
level nodes may later become grouped replay units.

### 2. Stable Node Identity

Each executable node needs a stable id derived from script structure, such as:

- script digest
- canonical AST path
- source span

This id should survive formatting-only edits where possible, but the first pass
can tolerate a simpler path-based id.

### 3. Dynamic Visit Identity

The same node may execute more than once. Replay cannot key only on the node id.

A visit identity should include:

- node id
- function call stack
- loop iteration counters
- branch path
- subshell depth
- cwd
- env input fingerprint
- stdin or other command input fingerprints

Without this, repeated commands in loops and branches will collide.

### 4. Workspace Layers

Before a command runs:

- capture workspace pre-state

After the command finishes:

- capture workspace post-state
- compute a layer diff
- persist the diff plus command metadata

The layer should include:

- files created
- files updated
- files deleted
- content digests
- optional metadata such as mode and size

This gives the experiment a concrete durability substrate without requiring a
full general-purpose effect model on day one.

### 5. Process State Journal

Each command visit should also capture:

- argv or normalized command text
- cwd
- env snapshot or env diff
- stdout
- stderr
- exit code
- timestamps

This metadata is not the layer itself, but it is required for debugging,
replayability decisions, and user-facing observability.

## Host Binary Execution

For CI/CD, host binaries are required.

The runtime should be designed around real command execution for tools like:

- `make`
- `prettier`
- `git`
- `docker`
- language-specific toolchains

This implies a split of responsibilities:

- interpreter owns Bash parsing and control flow
- command executor owns spawning real commands inside the tracked workspace
- journaling layer records the resulting process and workspace changes

`just-bash` is useful here primarily for parsing and interpreter structure, not
as the final execution substrate for every command.

## Caching And Replay

The replay key should combine:

- script identity
- node identity
- visit identity
- command inputs
- relevant workspace dependency state
- optional manual dependency hashes supplied by the caller

The resulting cache value should contain:

- command result metadata
- workspace layer diff

Replay then means:

1. confirm the replay key matches
2. restore or apply the recorded workspace layer
3. return the recorded stdout, stderr, and exit code

The current experiment only fully reuses stdout and stderr at the whole-run
level when every command visit in the rerun resolves from cache. Per-command log
replay remains a later refinement.

The MVP replay rule is prefix-oriented:

- replay may occur only up to the first cache miss
- once a command reruns, every downstream command reruns
- replay does not re-enter later in the same run

That is why the Docker layer analogy is useful: we are not just caching a return
value, we are caching a filesystem transition.

## Naive First Assumption

For the experiment, assume:

- the tracked workspace contains the state that matters
- filesystem diffing is acceptable even if expensive
- external state can be ignored or treated as out of scope for the first pass

Under that assumption, the first implementation should be:

1. real command execution
2. explicit workspace root
3. pre/post workspace snapshots
4. journal-only persistence first
5. replay later

The current runtime has now moved one step past this:

- exact-match replay exists
- manual dependency hashes can participate in invalidation
- workspace fingerprinting breaks downstream cache when upstream state changes

This is intentionally naive but useful. It is the fastest way to test whether
command-level durability produces meaningful CI/CD behavior.

## Snapshot Strategy

Three likely strategies:

### Full recursive snapshot

Pros:

- simplest implementation
- easiest to reason about

Cons:

- expensive on large repos

### Incremental diff by metadata

Pros:

- cheaper than full content hashing

Cons:

- less precise
- harder to trust

### Overlay or copy-on-write tracking

Pros:

- best long-term shape
- naturally layer-oriented

Cons:

- more engineering
- more complexity around integration with real host binaries

For the lab, start with full recursive snapshots and accept the cost.

## Explicit Overrides

Explicit durability syntax may still be useful later, but only as a policy
override:

- group commands into a single layer
- mark commands as never replayable
- force a stronger invalidation contract

Examples:

```bash
durable begin build
make build
make package
durable end
```

```bash
cache policy docker=never
cache policy prettier=workspace
```

These should refine the implicit command-visit model, not replace it.

## Next Steps

1. Replace stale directive-oriented assumptions in the runtime.
2. Add a host command executor bound to an explicit workspace root.
3. Capture full pre/post workspace snapshots around every command visit.
4. Persist command journals and layer metadata.
5. Add replay only after the journal shape is proven useful.

## Open Questions

- How much env should be hashed into the replay key by default?
- When should a pipeline be one layer versus multiple command layers?
- How do we eventually model state outside the tracked workspace?
- Should function calls get their own grouped layer abstraction?
- Do we materialize full snapshots, diffs, or content-addressed layer blobs?
