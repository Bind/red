# @redc/daemons

Markdown-authored AI daemons for red.

A daemon is a `*.daemon.md` file with two-field frontmatter and a prose body.
The file's directory is the daemon's working directory and the limit of its
scope — it can only read and write files under that subtree.

Invocation is explicit: `redc daemons run <name>`. The framework spawns a
Codex agent session (via `@openai/codex-sdk`, which picks up ChatGPT
subscription credentials from `codex login`), injects the body as the
daemon's brief, and loops until the agent emits a fenced `complete` block.
No cron, no event triggers — those layer on later.

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
3. Do Z.

Don't touch files outside this directory.
```

Both frontmatter fields are required:

- `name` — kebab-case, 1-64 chars, starts with a letter, unique in the repo.
- `description` — one sentence, under 200 chars, shown in `daemons list`.

Nothing else is valid frontmatter; unknown keys fail validation.

## The `complete` tool

The framework ships a tiny stdio MCP server (`src/mcp-server/complete.ts`)
that exposes a single tool named `complete`. Codex loads it via its
`mcp_servers` config, so the model sees `complete` alongside the built-in
Read/Edit/Write/Bash/etc. tools.

The runner invokes the Codex thread in streaming mode and watches each
turn's items for an `mcp_tool_call` with `server == "redc-daemons"` and
`tool == "complete"`. When it fires, the runner validates the arguments
with zod and ends the run. Otherwise it nudges ("Continue; if you are
finished, call the `complete` tool…") and takes another turn.

Tool input schema:

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

Each finding becomes a `daemon.finding` wide-event, so the "what invariants
are currently violated" view reconstructs from the event stream.

## CLI

```bash
redc-daemons list [--root <dir>]
redc-daemons show <name> [--root <dir>]
redc-daemons run  <name> [--root <dir>] [--input <text>] [--max-turns N] [--max-ms N]
```

`list` walks `**/*.daemon.md` under the root (defaults to `cwd`), skipping
`node_modules`, `.git`, build output directories, etc.

`run` emits JSONL wide-events to stdout matching red's envelope
(`event_id`, `kind`, `ts`, `route_name`, `data`) and prints the final
`complete` payload on success.

## Provider selection

Default: `codex` via `@openai/codex-sdk`. Needs `codex login` for subscription
auth; the SDK will surface its own error if unauthenticated.

Override via `AI_DAEMONS_PROVIDER=<name>`. Only `codex` is implemented today;
a Claude Agent SDK adapter is a one-file addition later, bound to the same
`AgentProvider` interface in `src/providers/types.ts`.

## Scope enforcement

Codex is spawned with `workingDirectory = <dir of the .daemon.md>` and
`sandboxMode = "workspace-write"`, which restricts file writes to that tree.
Reads are unrestricted by Codex; the body is the author's contract to stay
local.

## Hard rails

- `--max-turns` (default 20) — hard cap on continue-loop iterations.
- `--max-ms` (default 300_000) — wallclock budget per run.

Both are enforced by the runner, not by frontmatter. A daemon cannot raise
these caps.

## What's deferred

- `on:` event triggers and `cron:` schedules (frontmatter is MVP two-field).
- Claude Agent SDK provider.
- Persistent memory store (daemons can read/write `<scope>/.daemons/*` via
  standard tools for now).
- Hot reload, per-daemon budgets, per-daemon tool allowlists.

## Library use

```ts
import { loadDaemons, resolveDaemon, runDaemon, memorySink } from "@redc/daemons";

const { specs } = await loadDaemons();
const { emit, drain } = memorySink();
const result = await runDaemon("pr-health", { input: "sweep", emit });
console.log(result, drain());
```
