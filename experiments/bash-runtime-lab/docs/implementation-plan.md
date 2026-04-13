# Implementation Plan

Concrete phased plan for `experiments/bash-runtime-lab`.

## Current Status

Completed:

- Phase 0
- Phase 1
- Phase 2
- Phase 3
- Phase 4
- Phase 5, first replay slice

Current Phase 5 scope:

- exact-match replay for command visits
- replay only for the matching prefix of a run
- the first miss disables replay for all downstream commands in that run
- workspace layer reuse
- preserved cached exit codes
- full run `stdout` and `stderr` reuse when an entire rerun resolves from cache
- manual dependency hashes folded into invalidation

Still deferred within or after Phase 5:

- partial-run stdout and stderr replay at per-command fidelity
- broader replay policy beyond exact-match command visits

## Phase 0: Scope

Lock the first runtime contract:

- one explicit workspace root per run
- one Bash script entrypoint
- real host binaries allowed
- command-level journaling only
- no replay yet

Exit criteria:

- representative CI-style scripts run inside the experiment package

## Phase 1: Execution Core

Build the interpreter and executor split:

- parse Bash into an AST
- assign stable ids to executable command nodes
- track dynamic visit counts during execution
- execute the transformed script through real `bash`
- allow host binaries like `make`, `prettier`, and `docker`

Exit criteria:

- loops, conditionals, functions, and pipelines execute while the runtime emits
  per-command events

## Phase 2: Workspace Tracking

Add naive workspace tracking around every command visit:

- capture full workspace pre-state
- execute the command
- capture full workspace post-state
- compute created, updated, and deleted files plus content digests

Exit criteria:

- every command event includes a workspace diff layer

## Phase 3: Journal Format

Persist the first real run journal schema:

- run metadata
- command node metadata
- visit identity
- cwd and env snapshots
- stdout, stderr, exit code
- workspace diff layer

Exit criteria:

- a completed run can be inspected from stored data alone

## Phase 4: CI/CD Validation

Run the runtime against representative workflows:

- formatting
- build
- test
- docker-oriented pipeline

Exit criteria:

- we know whether command-level layers are a useful durability abstraction for
  real CI/CD scripts

Status:

- completed for the first experiment slice with representative shell, pipeline,
  and replay validation inside `bash-runtime-lab`

## Phase 5: Replay Prototype

Add replay for a narrow safe subset:

- exact node and visit match
- exact input match
- replay only until the first miss
- restore or apply stored workspace layer
- preserve stored exit code
- reuse full run stdout and stderr when the rerun resolves entirely from cache
- fold manual dependency hashes into the replay key
- use the pre-command workspace fingerprint so upstream changes invalidate
  downstream cache

Exit criteria:

- at least one real workflow can skip previously completed commands correctly

Status:

- partially completed
- exact-match replay works
- dependency-hash invalidation works
- full per-command stdout and stderr replay remains deferred

## Phase 6: Policy Layer

Add durability controls:

- replay allowlist and denylist
- explicit non-replayable commands
- grouped boundaries as overrides
- env and input invalidation rules

Exit criteria:

- replay policy is explicit instead of implicit guesswork

## Phase 7: Optimization

Only optimize after the model is proven:

- incremental snapshotting
- overlay or copy-on-write tracking
- content-addressed layer blobs
- better stable node identity

Exit criteria:

- lower cost without changing semantics
