# Smithers Lab

Starter experiment for evaluating the [smithers.sh](https://smithers.sh/) orchestrator inside the redc repo shape.

## What It Does

- runs a small two-step Smithers workflow with OpenAI
- includes a diagnosis-only Smithers workflow for recurring root `>=500` obs failures
- exposes a thin Hono HTTP surface for health and workflow execution
- persists Smithers runs to SQLite
- keeps local tooling self-contained with Bun, Biome, and `just`
- returns Smithers run metadata from HTTP while the durable task outputs live in SQLite

## Endpoints

- `GET /health`
- `POST /workflows/research-brief`
- `POST /triggers/wide-events/500`
- `POST /triggers/wide-events/poll`

Example request:

```bash
curl -X POST http://127.0.0.1:4090/workflows/research-brief \
  -H 'content-type: application/json' \
  -d '{"topic":"How should we evaluate smithers.sh for redc?","audience":"engineering"}'
```

Wide-event trigger request:

```bash
curl -X POST http://127.0.0.1:4090/triggers/wide-events/500 \
  -H 'content-type: application/json' \
  -d '{
    "requestId":"req_500_1",
    "isRootRequest":true,
    "service":"api",
    "route":"/rpc/app/hosted-repo",
    "method":"GET",
    "statusCode":500,
    "requestState":"error",
    "rolledUpAt":"2026-04-08T12:00:00Z",
    "rollupReason":"terminal_event",
    "fingerprint":"api:/rpc/app/hosted-repo:500:typeerror",
    "occurrenceCount":3,
    "windowMinutes":15,
    "severity":"high",
    "repo":"apps/ctl"
  }'
```

The first implementation slice is diagnosis-only:

- recurrence or critical-severity gating happens at the trigger endpoint
- Smithers runs the classifier, evidence, and context tasks in parallel
- the workflow produces a repair-plan recommendation and workflow summary
- no patch creation or PR opening happens yet

Listener-style poll request:

```bash
curl -X POST http://127.0.0.1:4090/triggers/wide-events/poll \
  -H 'content-type: application/json' \
  -d '{
    "since":"2026-04-08T11:45:00Z",
    "services":["api"],
    "requestStates":["completed"],
    "finalOutcomes":["error"],
    "minStatusCode":500,
    "requireTerminal":true,
    "limit":20
  }'
```

This is the intended direction for the listener:

- query canonical wide-event rollups by terminal characteristics
- require root requests by default so propagated child traffic does not trigger autofix
- map matching requests into autofix trigger candidates
- gate on recurrence or critical severity
- start diagnosis workflows only for accepted candidates

The current experiment defines the query contract and polling endpoint, but it still needs a real obs reader implementation against the canonical rollup store.

## Config

Dev defaults are intentionally light:

- `SMITHERS_LAB_HOST` defaults to `127.0.0.1`
- `SMITHERS_LAB_PORT` defaults to `4090`
- `SMITHERS_LAB_DB_PATH` defaults to `./data/smithers-lab.sqlite`
- `SMITHERS_LAB_OPENAI_MODEL` defaults to `gpt-5-mini`
- `SMITHERS_LAB_ALLOW_NETWORK` defaults to `false`

Set `OPENAI_API_KEY` before running the workflow.

Compose mode is strict and expects:

- `SMITHERS_LAB_HOST_DATA_DIR`
- `SMITHERS_LAB_OPENAI_API_KEY`
- `SMITHERS_LAB_OPENAI_MODEL`

## Run

```bash
cd experiments/smithers-lab
just install
OPENAI_API_KEY=... just serve
```

For a direct one-shot CLI run:

```bash
cd experiments/smithers-lab
OPENAI_API_KEY=... just run "Build a short evaluation plan for smithers.sh"
```

## Verify

```bash
cd experiments/smithers-lab
just typecheck
just test
SMITHERS_LAB_OPENAI_API_KEY=dummy \
SMITHERS_LAB_OPENAI_MODEL=gpt-5-mini \
SMITHERS_LAB_HOST_DATA_DIR="$(pwd)/.tmp-compose-data" \
just compose-e2e
```

## Notes

- The upstream `bunx smithers-orchestrator init` command currently fails under Bun 1.3.10 in this environment because of a missing `picocolors` dependency, so this experiment is scaffolded manually against the published package API.
- With `smithers-orchestrator@0.14.1`, `runWorkflow(...)` does not expose a simple final workflow output for this shape, so the API currently returns run metadata and stores step outputs in the SQLite database.

## Workflow Specs

- [wide-event-500-autofix](./workflows/wide-event-500-autofix.md): first-pass design for an obs-triggered Smithers diagnosis and red-forge PR workflow
