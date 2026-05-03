# @red/daemons

Markdown-authored AI daemons for red.

A daemon is a `*.daemon.md` file with required identity frontmatter, optional
review metadata, and a prose body.
The file's directory is the daemon's working directory and the limit of its
scope — it can only read and write files under that subtree.

Invocation is explicit: `red-daemons run <name>`. The framework spawns a
`@mariozechner/pi-agent-core` Agent, hands it the standard `pi-coding-agent`
toolkit (`read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`) plus our own
in-process `complete` tool, and lets the Agent loop until `complete` is
called or a budget is exhausted. No cron, no event triggers — those layer on
later.

## Authoring

```markdown
---
name: pr-health
description: Keep PR summaries current with their commit SHA.
review:
  max_turns: 12
  routing_categories:
    - name: command-surface
      description: Root docs and CLI entrypoints that define the operator surface.
---

# PR Health

You maintain PR summaries for this directory. On invocation:

1. Do X.
2. Do Y.
3. When finished, call the `complete` tool with a summary and any findings.
```

Required frontmatter fields:

- `name` — kebab-case, 1-64 chars, starts with a letter, unique in the repo.
- `description` — one sentence, under 200 chars, shown in `daemons list`.

Optional review metadata:

- `review.max_turns` — daemon-specific turn budget override for review workflows.
- `review.routing_categories` — cheap-routing hints used by daemon-review's
  local router to map changed files to the right daemon before the full audit runs.

Unknown keys still fail validation.

## Daemon Review Routing

`daemon-review` routes changed files to zero, one, or multiple daemons before
running the full audits.

The intended routing policy is:

- use structured signals first for known files: PR diff info, tracked subject
  dependencies, and other daemon-memory links
- use local embeddings primarily for cold-start routing of new files or weak-
  confidence files, especially when a PR introduces many new files
- allow zero daemons when no daemon scores strongly enough
- allow multiple daemons when several daemon surfaces are meaningfully similar

The semantic daemon profile should come from high-intent daemon-owned data:

- daemon `name`
- daemon `description`
- `review.routing_categories`
- daemon body text
- tracked subject names
- invariant names from prior findings

Do **not** use broad historical checked-file vocabulary as embedding text.
Daemons can open files during exploration and decide they are irrelevant, so
"file was once checked" is too noisy to define semantic ownership.

Checked-file history may still be useful as a separate structural routing
signal, for example:

- exact file revisit boosts
- path-neighborhood boosts
- tracked `depends_on` file boosts

but that should stay outside the embedding text itself.

When embeddings are used for file routing, prefer compact file summaries over
raw full-file bodies. Useful file-summary inputs include:

- file path, filename, extension, and path tokens
- imports, includes, env vars, config keys, exported symbols, and commands
- headings, docstrings, or comments that expose intent
- short content excerpts only when they materially improve classification

This keeps routing focused on:

- memory and dependency structure for known surfaces
- semantic placement for newly introduced surfaces

instead of forcing every daemon to rediscover large new PRs from scratch.

For the workflow-specific implementation plan, see
[bureau/workflows/daemon-review/README.md](../../bureau/workflows/daemon-review/README.md).

## The `complete` tool

The framework registers `complete` as a real in-process tool on the Agent.
Its schema (TypeBox) is:

```
{
  summary: string                // required, one-sentence recap
  findings?: Array<{
    invariant: string            // snake_case tag
    target?: string              // optional path or id
    status: "ok" | "healed" | "violation_persists" | "skipped"
    note?: string
  }>
  nextRunHint?: string           // optional advice for the next run
}
```

When the model calls `complete`, the runner captures the arguments (validated
with zod), emits one `daemon.finding` wide-event per entry, one
`daemon.run.completed`, and exits. Subsequent turns are suppressed.

## Provider and subscription auth

Default provider is `pi`, which speaks to Codex via the
`openai-codex-responses` API using OAuth subscription credentials. The
adapter accepts a pluggable `CodexAuthSource`:

```ts
import {
  createFileCodexAuthSource,
  createInMemoryCodexAuthSource,
  createPiProvider,
  runDaemon,
} from "@red/daemons";

// Default: reads ~/.codex/auth.json (written by `codex login`)
const provider = createPiProvider({
  authSource: createFileCodexAuthSource(),
});

// Red-owned flow: inject credentials from your own store
const provider = createPiProvider({
  authSource: createInMemoryCodexAuthSource({
    access: "<jwt>",
    refresh: "<refresh-token>",
    expires: Date.now() + 25 * 60_000,
  }),
});

await runDaemon("readme-links", { provider });
```

The `CodexAccessTokenManager` wraps any auth source and handles transparent
refresh via `refreshOpenAICodexToken` when the access token is within 60s of
expiry.

For CI, the same `pi` runtime can also target API-key-backed providers. The
current supported machine-auth path is OpenRouter:

```bash
export AI_DAEMONS_PROVIDER=openrouter
export AI_DAEMONS_MODEL=deepseek/deepseek-v4-flash
export OPENROUTER_API_KEY=...
```

That uses pi-ai's built-in OpenRouter model registry and resolves auth from
`OPENROUTER_API_KEY` instead of `~/.codex/auth.json`.

## Commit-anchored daemon memory

Runner-managed daemon memory is now stored as commit snapshots rather than a
single mutable "last run" blob. Each daemon reuses the nearest ancestor
snapshot it can find for the current `HEAD`, invalidates tracked facts whose
dependencies changed, and writes a fresh snapshot for the current commit.

Local runs default to a file-backed store under `.daemons-cache/`. To share the
same commit snapshots between local runs and CI, provision infra through SST
with:

```bash
just provision dev .env .env.ci
```

That deploys the infra stack and syncs the exported daemon-memory R2 vars from
`.sst/outputs.json` into the requested env files. Once those env vars are
present, both local runs and CI can use the R2-backed store with:

```bash
export AI_DAEMONS_MEMORY_BACKEND=r2
export AI_DAEMONS_MEMORY_REPO=Bind/red
export AI_DAEMONS_R2_BUCKET=...
export AI_DAEMONS_R2_ACCESS_KEY_ID=...
export AI_DAEMONS_R2_SECRET_ACCESS_KEY=...
```

Optional:

```bash
export AI_DAEMONS_R2_ENDPOINT=...
export AI_DAEMONS_MEMORY_PREFIX=daemon-memory/v1
export AI_DAEMONS_R2_REGION=auto
```

If `AI_DAEMONS_R2_ENDPOINT` is omitted and `CLOUDFLARE_ACCOUNT_ID` is set, the
runner defaults to `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`.

If `AI_DAEMONS_MEMORY_BACKEND` is unset, the runner stays on the local
filesystem backend.

## CLI

The two headline commands for MVP are `auth` and `run`. `list` and `show` are
read-only utilities.

### `red-daemons auth [--store <path>]`

Runs the ChatGPT / Codex OAuth flow via pi-ai's `loginOpenAICodex` and
persists the resulting credentials. Default store is `~/.codex/auth.json`,
which matches the format written by the stock `codex login` CLI so the two
are interchangeable — either command satisfies the file-backed auth source.

```bash
red-daemons auth                           # default: writes ~/.codex/auth.json
red-daemons auth --store ~/.red/auth.json  # custom location
```

### `red-daemons run <name>`

Loads the named daemon, spawns a pi-agent-core Agent scoped to the daemon's
directory, runs until `complete` is called or a budget expires.

```bash
red-daemons run readme-links
red-daemons run readme-links --root experiments/ai-daemons-lab
red-daemons run readme-links --input "focus on the install section"
red-daemons run readme-links --max-turns 10 --max-ms 120000
```

Emits JSONL wide-events to stdout matching red's envelope (`event_id`,
`kind`, `ts`, `route_name`, `data`) and prints the final `complete` payload
as pretty JSON on success. Exits non-zero on failure with the reason on
stderr.

### `red-daemons list [--root <dir>]`

Walks `**/*.daemon.md` under the root (defaults to `cwd`), skipping
`node_modules`, `.git`, build directories. Prints `name  file\n  description`
per daemon.

### `red-daemons show <name> [--root <dir>]`

Prints the resolved frontmatter, body, and scope root of a single daemon
without invoking it.

## Wide-events emitted per run

- `daemon.run.started` — runId, provider, file, scopeRoot, input
- `daemon.turn.started` — runId, turn
- `daemon.tool.called` — runId, turn, toolName (every tool call, including `complete`)
- `daemon.turn.completed` — runId, turn, inputTokens, outputTokens, completeCalled
- `daemon.finding` — runId, invariant, target, status, note (one per finding)
- `daemon.run.completed` — runId, turns, summary, findingCount, nextRunHint, tokens
- `daemon.run.failed` — runId, reason, message, turns, tokens

## Scope enforcement

The Agent runs with `cwd = <dir of the .daemon.md>`. `pi-coding-agent`'s
tools are pre-scoped to that cwd — `read`, `edit`, `write`, `grep`, `find`,
`ls` all reject paths that escape. `bash` is trust-based for MVP; the system
preamble tells the daemon to stay local.

## Hard rails

- `--max-turns` (default 20) — hard cap on the Agent's prompt/continue cycles.
- `--max-ms` (default 300_000) — wallclock budget per run. The runner aborts
  the Agent when this expires.

Both are enforced by the runner, not by frontmatter. A daemon cannot raise
these caps.

## What's deferred

- `on:` event triggers and `cron:` — event scheduling still lives outside daemon frontmatter.
- Claude Agent SDK provider — same `AgentProvider` interface, swap in later.
- Hot reload, per-daemon budgets, per-daemon tool allowlists.

## Library use

```ts
import {
  loadDaemons,
  resolveDaemon,
  runDaemon,
  memorySink,
  createPiProvider,
  createFileCodexAuthSource,
} from "@red/daemons";

const { specs } = await loadDaemons();
const { emit, drain } = memorySink();
const provider = createPiProvider({
  authSource: createFileCodexAuthSource(),
});
const result = await runDaemon("readme-links", {
  input: "sweep",
  emit,
  provider,
});
console.log(result, drain());
```
