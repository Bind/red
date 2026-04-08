# Wide Events Lab

Experiment for modeling wide-event observability with DuckDB and a local polling agent.

## Goals

- ingest append-only wide events emitted by services
- materialize one canonical request row per `request_id`
- preserve raw lineage while giving agents a compact request record to inspect
- keep the first agent loop decoupled from any runtime-specific job system

## Layout

- `src/service/collector-contract.ts`: HTTP transport contract for the collector
- `src/service/app.ts`: Hono collector app
- `src/service/collector-service.ts`: batch validation and acceptance flow
- `src/store/minio-store.ts`: Bun `S3Client` raw and rollup sinks for MinIO
- `src/store/raw-event-store.ts`: raw append-only NDJSON storage
- `src/store/rollup-store.ts`: canonical request rollup storage
- `src/store/schema.sql`: raw event and canonical request schema
- `src/store/canonical-requests.sql`: DuckDB materialization for one request row per `request_id`
- `src/store/incident-candidates.sql`: starter anomaly queries for a local polling agent
- `src/agent/bootstrap.ts`: local DuckDB and MinIO config bootstrap for the agent
- `src/agent/sync-rollups.ts`: sync rollup objects locally for hot agent access
- `src/agent/write-duckdb-sql.ts`: write DuckDB bootstrap SQL for S3-backed views
- `src/service/canonical-request.ts`: TypeScript reference merge logic
- `src/test/canonical-request.test.ts`: fixture-driven merge tests

## Collector Interface

Services should emit append-only events and stay ignorant of DuckDB and agent logic.

Recommended write path:

- `POST /v1/events`
- `content-type: application/json`
- optional `authorization: Bearer <token>`

Request shape:

```json
{
  "sent_at": "2026-04-08T14:00:00.000Z",
  "source": {
    "service": "bff",
    "instance_id": "bff-7f6d9"
  },
  "events": [
    {
      "event_id": "evt_1",
      "request_id": "req_123",
      "service": "bff",
      "kind": "request.received",
      "ts": "2026-04-08T14:00:00.100Z",
      "route_name": "session_exchange",
      "data": {
        "request": {
          "method": "POST",
          "path": "/session/exchange"
        }
      }
    }
  ]
}
```

Response shape:

```json
{
  "accepted": 1,
  "rejected": 0,
  "request_ids": ["req_123"]
}
```

Validation errors should be reported by `event_id`, not as one opaque batch failure.

## Canonical Request Model

Raw events stay immutable. The canonical request row is derived from all wide events that share a `request_id`.

The current merge rules are:

- earliest event wins for entry request metadata
- latest status-bearing event wins for final response fields
- requests without any terminal event are marked `incomplete`
- `error` beats `ok`
- arrays are deduplicated
- nested objects merge recursively
- scalar conflicts are preserved under `_conflicts`

Canonical request rows now carry:

- `has_terminal_event`
- `request_state` as `completed` or `incomplete`
- `final_outcome` as `ok`, `error`, or `unknown`

That keeps crash-truncated request histories queryable without falsely reporting them as successful.

## Run

```bash
just wide-events-lab-install
just wide-events-lab-serve
just wide-events-lab-test
just wide-events-lab-typecheck
```

Main env vars:

- `WIDE_EVENTS_LAB_HOST`
- `WIDE_EVENTS_LAB_PORT`
- `WIDE_EVENTS_LAB_DATA_DIR`
- `WIDE_EVENTS_LAB_RAW_EVENTS_DIR`
- `WIDE_EVENTS_LAB_ROLLUP_DIR`
- `WIDE_EVENTS_LAB_SWEEP_INTERVAL_MS`
- `WIDE_EVENTS_LAB_INCOMPLETE_GRACE_MS`

The collector currently:

- accepts `POST /v1/events`
- appends accepted events to `raw/date=YYYY-MM-DD/service=<name>/events.ndjson`
- keeps active request state in memory keyed by `request_id`
- writes canonical rollups to `rollup/date=YYYY-MM-DD/hour=HH/rollups.ndjson`
- flushes stale requests as `request_state = incomplete`
- replays recent raw events on startup to recover from collector crashes

The rollup records include `rollup_reason`, `rolled_up_at`, and `rollup_version` so the local agent can prefer rollups and fall back to raw events only when it needs deeper replay detail.

## Agent Bootstrap

```bash
just wide-events-lab-agent-bootstrap
cd experiments/wide-events-lab && bun run src/agent/sync-rollups.ts
cd experiments/wide-events-lab && bun run src/agent/write-duckdb-sql.ts
```

## Compose

```bash
export WIDE_EVENTS_S3_ACCESS_KEY_ID=minioadmin
export WIDE_EVENTS_S3_SECRET_ACCESS_KEY=minioadmin
docker compose -f experiments/wide-events-lab/docker-compose.yml up --build
```

## Notes

- This experiment intentionally does not depend on `claw`.
- The TypeScript merge logic is the semantic reference.
- The DuckDB SQL is the materialized analytics layer.
