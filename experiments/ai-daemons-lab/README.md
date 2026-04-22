# AI Daemons Lab

A small probe into the "AI daemons" pattern popularised at
[ai-daemons.com](https://ai-daemons.com): long-lived, autonomous background
processes that each own one narrow invariant ("keep PRs mergeable", "keep issues
triaged", "keep docs current") and heal it without a human in the loop.

Where a typical agent is prompt → reply → done, a daemon:

- runs on its own schedule (tick loop, not on-demand)
- owns one invariant and acts whenever it drifts
- accumulates memory across ticks so repeat work is cheap
- operates inside the team's existing surfaces (here: changes and issues)
- is narrow enough that its success criterion is observable

This experiment sketches the runtime shape in isolation from the rest of red:
no DB, no compose stack, no network by default.

## What's inside

```
src/
├── kernel.ts              supervisor: registers daemons, runs their ticks, emits lifecycle events
├── daemon.ts              Daemon / DaemonContext / TickResult types
├── wide-events.ts         stdout + in-memory sinks matching red's event envelope
├── world/
│   ├── change-store.ts    in-memory PR-like records
│   └── issue-store.ts     in-memory issue records
├── daemons/
│   ├── pr-health.ts       regenerates stale summaries, assigns default reviewers
│   └── stale-issue.ts     labels untriaged issues once they cross an age threshold
├── healers/
│   ├── types.ts           Healer interface
│   ├── stub.ts            deterministic default (no network)
│   └── openai.ts          optional real summariser gated on OPENAI_API_KEY
└── test/                  bun test coverage for the kernel and both daemons
```

## Run

```bash
cd experiments/ai-daemons-lab
just install
just run                    # default: 30s with the stub healer
```

The bootstrap loop wires:

- a `ChangeStore` and `IssueStore` seeded with demo data
- the two daemons registered into one `DaemonKernel`
- a small world-drift timer that advances a random change's commit SHA so the
  `pr-health` daemon has something to do on each tick
- a graceful shutdown on `SIGTERM`, `SIGINT`, or the configured duration

Each daemon tick emits JSONL wide-events on stdout with red's canonical shape
(`event_id`, `kind`, `ts`, `route_name`, `data`). You can pipe them into `jq`:

```bash
just run | jq 'select(.kind | startswith("daemon."))'
```

## Use a real LLM (optional)

If `OPENAI_API_KEY` (or `AI_DAEMONS_OPENAI_API_KEY`) is set, `pr-health` will
use `OpenAIHealer` via the OpenAI Chat Completions REST endpoint instead of the
stub. Model is read from `AI_DAEMONS_OPENAI_MODEL` (defaults to `gpt-5-mini`).

```bash
OPENAI_API_KEY=... just run 60
```

No other network calls happen. The healer interface is intentionally minimal so
swapping in the Anthropic SDK or red's in-process Claw runner later is a
one-file change.

## Verify

```bash
just typecheck
just test
```

## Config

| env var | default | effect |
|---|---|---|
| `AI_DAEMONS_RUN_SECONDS` | `30` | how long the main loop runs |
| `AI_DAEMONS_PR_TICK_MS` | `2000` | pr-health tick interval |
| `AI_DAEMONS_ISSUE_TICK_MS` | `5000` | stale-issue tick interval |
| `AI_DAEMONS_DRIFT_MS` | `3000` | interval at which the world injects a new commit SHA |
| `OPENAI_API_KEY` | _(unset)_ | enables the OpenAI healer |
| `AI_DAEMONS_OPENAI_MODEL` | `gpt-5-mini` | model used by the OpenAI healer |

## Status

First-pass probe. Clear next steps if this pattern earns its keep in red:

- wire a daemon against the real `ChangesStore` / `JobWorker` in `apps/ctl/`
- ship wide-events to the collector instead of stdout
- add a docs-freshness daemon that watches `apps/grs/zig/` and re-summarises README drift
- evaluate whether the kernel should supersede or compose with the existing `JobWorker`
