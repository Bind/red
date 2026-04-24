# @redc/daemons

Markdown-authored AI daemons for red.

A daemon is a `*.daemon.md` file with two-field frontmatter and a prose body.
The file's directory is the daemon's working directory and the limit of its
scope — it can only read and write files under that subtree.

Invocation is explicit: `redc-daemons run <name>`. The framework spawns a
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
---

# PR Health

You maintain PR summaries for this directory. On invocation:

1. Do X.
2. Do Y.
3. When finished, call the `complete` tool with a summary and any findings.
```

Both frontmatter fields are required:

- `name` — kebab-case, 1-64 chars, starts with a letter, unique in the repo.
- `description` — one sentence, under 200 chars, shown in `daemons list`.

Nothing else is valid frontmatter; unknown keys fail validation.

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
} from "@redc/daemons";

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
export AI_DAEMONS_MODEL=deepseek/deepseek-v4-pro
export OPENROUTER_API_KEY=...
```

That uses pi-ai's built-in OpenRouter model registry and resolves auth from
`OPENROUTER_API_KEY` instead of `~/.codex/auth.json`.

## CLI

The two headline commands for MVP are `auth` and `run`. `list` and `show` are
read-only utilities.

### `redc-daemons auth [--store <path>]`

Runs the ChatGPT / Codex OAuth flow via pi-ai's `loginOpenAICodex` and
persists the resulting credentials. Default store is `~/.codex/auth.json`,
which matches the format written by the stock `codex login` CLI so the two
are interchangeable — either command satisfies the file-backed auth source.

```bash
redc-daemons auth                           # default: writes ~/.codex/auth.json
redc-daemons auth --store ~/.red/auth.json  # custom location
```

### `redc-daemons run <name>`

Loads the named daemon, spawns a pi-agent-core Agent scoped to the daemon's
directory, runs until `complete` is called or a budget expires.

```bash
redc-daemons run readme-links
redc-daemons run readme-links --root experiments/ai-daemons-lab
redc-daemons run readme-links --input "focus on the install section"
redc-daemons run readme-links --max-turns 10 --max-ms 120000
```

Emits JSONL wide-events to stdout matching red's envelope (`event_id`,
`kind`, `ts`, `route_name`, `data`) and prints the final `complete` payload
as pretty JSON on success. Exits non-zero on failure with the reason on
stderr.

### `redc-daemons list [--root <dir>]`

Walks `**/*.daemon.md` under the root (defaults to `cwd`), skipping
`node_modules`, `.git`, build directories. Prints `name  file\n  description`
per daemon.

### `redc-daemons show <name> [--root <dir>]`

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

- `on:` event triggers and `cron:` — frontmatter is MVP two-field.
- Claude Agent SDK provider — same `AgentProvider` interface, swap in later.
- Persistent memory store — daemons can read/write `<scope>/.daemons/*`
  through the standard file tools for now.
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
} from "@redc/daemons";

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
