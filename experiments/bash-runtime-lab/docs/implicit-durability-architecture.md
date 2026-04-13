# Implicit Durability Architecture

Design note for the next iteration of `bash-runtime-lab`.

## Decision

The default durable/cacheable unit should be an executable Bash node, not a line
and not a user-authored comment block.

The runtime should begin with a full Bash interpreter and attach journaling hooks
at command dispatch boundaries.

## Why Not Line-Level Caching

Line-level caching is the wrong abstraction for Bash:

- one line can contain multiple commands
- one command can span multiple lines
- heredocs, subshells, pipelines, and conditionals break any simple line model
- source lines do not encode runtime context such as loop iteration or branch
  choice

The interpreter already understands those semantics. The durability system should
reuse that structure instead of rebuilding a weaker proxy for it.

## Why A Full Interpreter First

The `just-bash` model is the right starting shape because it already demonstrates:

- TypeScript-native Bash execution
- AST parsing and transformation support
- pluggable/custom command surfaces
- filesystem abstraction

Relevant just-bash properties from its docs:

- each `exec()` call has isolated shell state while the filesystem is shared
- AST transform plugins are intended for instrumentation and metadata extraction

That is close to what we need, but not sufficient on its own. Durable replay
needs hooks in the interpreter runtime, not only a pre-execution transform pass.

## Proposed Runtime Shape

### 1. Parse Once

Parse the full Bash script into an AST and retain source spans for every
executable node.

### 2. Instrument Dispatch

Before evaluating an executable node, call into a durability hook:

- `beforeNode(context)`
- `afterNode(context, result)`
- `onStateMutation(event)`

The important nodes are:

- simple commands
- pipelines
- boolean lists
- subshells
- function calls
- loop bodies

Not every AST node should be a cache boundary. The hook layer should observe all
of them, while the policy layer decides which ones can be replayed safely.

### 3. Create A Stable Invocation Identity

A replay key needs more than the source text. It should combine:

- script digest
- node source span or canonical AST path
- normalized command text
- dynamic execution path
- runtime inputs

Dynamic execution path should include enough structure to disambiguate repeated
visits:

- function call stack
- loop iteration counters
- branch selections
- subshell depth

Without that, the runtime will incorrectly reuse results for repeated commands
that happen to share the same syntax.

### 4. Journal Effects

Each invocation should append a journal record with:

- invocation identity
- argv / stdin digest
- cwd
- relevant env snapshot or env diff
- stdout / stderr
- exit status
- start / end timestamps
- file reads
- file writes
- directory mutations

The filesystem layer should expose enough hooks to capture read/write intent and
produce a write-set summary.

### 5. Replay Policy

A previous invocation is replayable only if:

- the invocation identity matches
- the policy marks the node as cacheable
- upstream dependencies are compatible
- required state inputs still match

This implies two layers:

- interpreter hooks record facts
- replay policy decides whether those facts are reusable

## Cache Unit Hierarchy

The likely default hierarchy is:

1. simple command
2. pipeline
3. compound override

Simple command is the base unit because it is the narrowest meaningful effect
boundary.

Pipeline may need to be the replay unit when:

- pipe topology matters
- upstream stdout is not persisted as separate replayable artifacts

Compound override is the escape hatch when the user or runtime wants to group:

- a setup sequence
- a transaction-like region
- commands that are only safe to replay together

## Explicit Syntax As An Override

Explicit syntax is still useful, but it should not be required for first-class
durability.

Potential future forms:

```bash
durable begin build
make build
make package
durable end
```

or annotations that alter policy:

```bash
cache policy command=build mode=immutable
cache policy command=publish mode=never
```

Those constructs should override or refine the implicit command-level model.

## Practical Next Steps

1. Replace the current directive parser with an interpreter-backed execution
   core.
2. Add a command-dispatch event stream before adding any replay logic.
3. Instrument the filesystem abstraction to emit read/write mutation events.
4. Persist a command journal per run.
5. Prototype replay for a narrow safe subset:
   pure built-ins plus explicitly approved commands.

## Open Questions

- How much env state should be hashed by default versus tracked as explicit
  dependencies?
- Should pipelines replay as a unit or as independently materialized command
  steps?
- How do we model commands with external side effects when the filesystem is not
  the only state surface?
- Should function bodies receive their own stable ids, or should replay only
  attach to the invoked commands inside them?
- When a command reads a file written by a prior command, do we key on content
  digest, journal lineage, or both?
