# Wide Events

Dedicated Bun/Hono collector service for request-wide events.

## Endpoints

- `GET /health`
- `GET /v1/rollups`
- `GET /v1/rollups/stats`
- `GET /v1/rollups/:request_id`
- `POST /v1/events`

## Behavior

- writes every accepted event to the raw lake first
- maintains in-memory request aggregates keyed by `request_id`
- writes canonical rollups on terminal events
- writes `request_state=incomplete` rollups after the timeout window
- replays recent raw events on startup for common restart recovery

## Main env vars

- `WIDE_EVENTS_HOST`
- `WIDE_EVENTS_PORT`
- `WIDE_EVENTS_STORAGE_BACKEND=file|minio`
- `WIDE_EVENTS_DATA_DIR`
- `WIDE_EVENTS_RAW_EVENTS_DIR`
- `WIDE_EVENTS_ROLLUP_DIR`
- `WIDE_EVENTS_INCOMPLETE_GRACE_MS`
- `WIDE_EVENTS_SWEEP_INTERVAL_MS`
- `WIDE_EVENTS_REPLAY_WINDOW_MS`
- `WIDE_EVENTS_S3_ENDPOINT`
- `WIDE_EVENTS_S3_REGION`
- `WIDE_EVENTS_S3_ACCESS_KEY_ID`
- `WIDE_EVENTS_S3_SECRET_ACCESS_KEY`
- `WIDE_EVENTS_RAW_BUCKET`
- `WIDE_EVENTS_RAW_PREFIX`
- `WIDE_EVENTS_ROLLUP_BUCKET`
- `WIDE_EVENTS_ROLLUP_PREFIX`
