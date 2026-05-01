# Daemon Review

`daemon-review` maps changed files to zero, one, or multiple daemons before
running the full audits.

For the broader runtime/package direction beyond this one workflow, see
[docs/agent-substrate.md](../../docs/agent-substrate.md).

The current router code is a transition state. The target design is a hybrid:

- use structured memory and dependency signals for known files
- use local embeddings mainly for new files, new surfaces, and weak-confidence
  cases
- allow no daemon when nothing scores strongly enough
- allow multiple daemons when several surfaces materially overlap

See [@red/daemons README](../../pkg/daemons/README.md) for the routing
principles. This file turns those principles into an implementation plan for
the workflow code.

## Current Validation

Today we have coverage for the routing shell, not the final hybrid design:

- `workflows/daemon-review/src/routing.test.ts`
  - empty routing-categories input returns no routes
  - mocked classifier outputs route files to the expected daemons
- `pkg/daemons/src/test/schema.test.ts`
  - daemon review metadata schema accepts the current frontmatter shape
- `pkg/daemons/src/test/loader.test.ts`
  - daemon review metadata loads into the runtime daemon spec

We do **not** yet have a trustworthy real-model routing test. The earlier
zero-shot MNLI smoke run showed that passing raw or near-raw file content into
the local classifier is not a viable long-term path.

## Target Routing Contract

For each changed file, the router should emit `0..N` daemons.

Routing sources, in order of trust:

1. Structured known-file signals
   - tracked subject `depends_on` links
   - other daemon-memory links tied to concrete files or topics
   - PR diff metadata
2. Local embeddings
   - new files
   - new surfaces with little or no daemon memory
   - weak-confidence or tie-break cases

The router should not treat "a daemon once opened this file while exploring" as
semantic ownership. Broad checked-file history is too noisy to become embedding
text.

## Daemon Semantic Profile

The daemon embedding/profile text should come from high-intent daemon-owned
signals only:

- daemon `name`
- daemon `description`
- `review.routing_categories`
- daemon body text
- tracked subject names
- invariant names from prior findings

Do not include broad historically checked-file vocabulary in the semantic
profile. A daemon may inspect files opportunistically and decide they are not
important.

## File Summary Contract

When embeddings are used, classify compact file summaries instead of raw file
bodies.

Candidate summary inputs:

- path, filename, extension, and path tokens
- imports, includes, requires, exports
- env vars and config keys
- shell commands and tool names
- headings, docstrings, comments
- short excerpts only when they add signal

The summarizer should be bounded and deterministic so large PRs and large files
do not blow up router cost or model input size.

## Hybrid Scoring

The target router should compute a per-file, per-daemon score from:

- `embedding_score`
- `dependency_boost`
- `topic_boost`
- optional `path_neighbor_boost`
- optional `exact_revisit_boost`

Selection rule:

- assign none if the top final score is below `min_score`
- otherwise assign all daemons whose score is at or above `min_score`
- keep only daemons within `max_gap` of the top score
- cap final fan-out at `top_k`

This keeps the router multi-label and allows unrelated files to receive no
daemon.

## Implementation Plan

### Phase 1: Summary and Profile Builders

Build explicit helpers for:

- `buildFileSummary(path, content)`
- `buildDaemonProfile(spec, memory)`

Requirements:

- actual file content must influence the summary
- summaries must stay compact and structured
- daemon profiles must only use high-intent semantic inputs

Add focused unit tests for both builders.

### Phase 2: Structured Routing Signals

Load routing-side daemon memory and derive structured boosts from:

- tracked subject `depends_on` matches
- topic dependency links
- optional exact file revisits
- optional path-neighborhood similarity

These signals stay outside the embedding text. They are score boosts, not the
semantic definition of daemon ownership.

Add tests that isolate each boost.

### Phase 3: Local Embedding Backend

Replace zero-shot MNLI routing with local embeddings via
`@huggingface/transformers`.

Requirements:

- embed daemon profiles once per run
- embed file summaries for files that need semantic routing
- prefer embeddings for new files and weak-confidence files
- skip or down-weight embeddings for files that already have strong structured
  routing signals

### Phase 4: Hybrid Selection and Debugging

Implement the fusion and selection logic:

- combine structured boosts with embedding similarity
- emit `0..N` daemons per file
- surface debug output showing:
  - file summary
  - daemon profile summary
  - raw similarity scores
  - structural boosts
  - final scores
  - selected daemons
  - exclusion reason when none are selected

Add dry-run fixtures that exercise:

- known-file routing
- cold-start new-file routing
- many-new-files PR behavior
- multi-daemon overlap
- no-daemon cases

For quick end-to-end evaluation against real repo files and real daemon specs,
run:

```bash
bun run workflows/daemon-review/src/smoke.ts
```

This smoke script intentionally uses actual repo paths like `README.md`,
`scripts/red`, and `infra/preview/*.sh` instead of synthetic placeholders.
It also prints per-file semantic scores, structured boosts, final scores, and
expected-vs-selected daemon names from the checked-in routing training set.

### Phase 5: Workflow Rollout

Keep rollout behind env flags until quality is stable.

Suggested knobs:

- router mode
- embedding model
- `min_score`
- `max_gap`
- `top_k`
- debug/smoke logging

Only switch the workflow default after:

- the summarizer/profile tests are stable
- hybrid dry runs look reasonable
- at least one real-model smoke pass shows acceptable routing on actual repo
  files

## Immediate Next Step

Implement Phase 1 first. The current highest-signal work is to make file
summaries and daemon profiles explicit, testable units before changing the
scoring backend again.
