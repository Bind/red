---
name: wide-events-observability
description: Use when debugging redc request flow, verifying wide-events ingestion, inspecting MinIO raw or rollup data, checking request_id propagation, or quickly tracing why a request did or did not materialize into a canonical rollup.
---

# Wide Events Observability

Use this skill when the task is about `pkg/obs`, `apps/wide-events`, MinIO-backed raw or rollup data, or request tracing across `api`, `bff`, `auth`, and `gs`.

## What matters

- Apps emit one wide event per inbound request through [`pkg/obs/src/core.ts`](/Users/db/workspace/redc/pkg/obs/src/core.ts).
- The collector in [`apps/wide-events`](/Users/db/workspace/redc/apps/wide-events) writes raw events first, then materializes request rollups in memory.
- Immediate rollup happens only for a terminal event with `is_request_root: true`.
- Requests without a root terminal event are emitted as `request_state = incomplete` after `WIDE_EVENTS_INCOMPLETE_GRACE_MS` (currently `60000` in compose).
- Raw storage is the truth. Rollups are fast derived visibility data.

## Fast path

1. Verify the stack is up.

```bash
docker compose --env-file .env -f infra/compose/dev.yml ps wide-events minio minio-init api bff auth git-server
curl -fsS "http://127.0.0.1:${WIDE_EVENTS_PORT}/health"
```

2. Trigger or capture a concrete `request_id`.

- Prefer reproducing with an explicit header:

```bash
curl -H 'x-request-id: debug-req-1' http://127.0.0.1:3001/rpc/app/hosted-repo
```

- If the request should be a root request, omit the header and let middleware mint it.

3. Check rollups first.

```bash
docker compose --env-file .env -f infra/compose/dev.yml run --rm minio-init sh -lc '
mc alias set local http://$MINIO_ENDPOINT:$MINIO_PORT "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null &&
mc find "local/$WIDE_EVENTS_ROLLUP_BUCKET/$WIDE_EVENTS_ROLLUP_PREFIX" --name "*.ndjson"
'
```

4. If needed, inspect raw events for the same request.

```bash
docker compose --env-file .env -f infra/compose/dev.yml run --rm minio-init sh -lc '
mc alias set local http://$MINIO_ENDPOINT:$MINIO_PORT "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null &&
mc find "local/$WIDE_EVENTS_RAW_BUCKET/$WIDE_EVENTS_RAW_PREFIX" --name "*.ndjson"
'
```

5. If the rollup is missing, decide which of these is true:

- the request never reached the collector
- the request is still waiting for a root terminal event
- the request is expected to remain child-only because the `request_id` was propagated
- the request should appear only after the incomplete timeout

## Querying by request_id

Use `mc cat` plus `rg` against the MinIO objects:

```bash
docker compose --env-file .env -f infra/compose/dev.yml run --rm minio-init sh -lc '
mc alias set local http://$MINIO_ENDPOINT:$MINIO_PORT "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null &&
mc cat "local/$WIDE_EVENTS_RAW_BUCKET/$WIDE_EVENTS_RAW_PREFIX"/date=*/service=*/*.ndjson
' | rg 'debug-req-1'
```

```bash
docker compose --env-file .env -f infra/compose/dev.yml run --rm minio-init sh -lc '
mc alias set local http://$MINIO_ENDPOINT:$MINIO_PORT "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null &&
mc cat "local/$WIDE_EVENTS_ROLLUP_BUCKET/$WIDE_EVENTS_ROLLUP_PREFIX"/date=*/hour=*/*.ndjson
' | rg 'debug-req-1'
```

Use raw when you need event-by-event lineage. Use rollups when you need the canonical request view.

## DuckDB path

When the user wants ad hoc analysis instead of grep:

```bash
bun run apps/wide-events/src/agent/bootstrap.ts
bun run apps/wide-events/src/agent/write-duckdb-sql.ts
```

Then use the generated SQL at `.wide-events-agent/duckdb-bootstrap.sql` with local DuckDB to create:

- `wide_event_rollups`
- `wide_event_raw`

Start with rollups, then drop to raw for detail or merge debugging.

## Root request rules

These rules are critical when a rollup looks incomplete or "missing".

- `is_request_root: true` means middleware minted the `request_id` at ingress.
- `is_request_root: false` means the `request_id` was propagated from upstream.
- Only a terminal root event finalizes the request immediately.
- A child service can emit a terminal event without closing the canonical request.
- If no root terminal event arrives, the collector emits an incomplete rollup after the grace window.

Check implementations in:

- [`pkg/obs/src/core.ts`](/Users/db/workspace/redc/pkg/obs/src/core.ts)
- [`apps/wide-events/src/service/collector-service.ts`](/Users/db/workspace/redc/apps/wide-events/src/service/collector-service.ts)
- [`apps/gs/zig/src/obs.zig`](/Users/db/workspace/redc/apps/gs/zig/src/obs.zig)

## Common diagnoses

- `raw exists, rollup missing`
  Usually means no root terminal event yet, or the request has not reached the incomplete timeout.

- `rollup exists but is missing downstream services`
  Usually means downstream events arrived after the root rollup emitted, or propagation is broken.

- `root request never materializes`
  Check whether the ingress service actually minted the request ID and emitted `is_request_root: true`.

- `commits or branches are empty in hosted repo payload`
  Inspect [`apps/bff/src/hosted-repo.ts`](/Users/db/workspace/redc/apps/bff/src/hosted-repo.ts). Optional repo fetches are timeout-bound and may fall back to empty arrays or `null`.

- `many incomplete rollups`
  Look for crashes, request aborts, or services that never call `finish(...)` on the envelope.

## Preferred response shape

When using this skill, answer with:

1. what path you inspected: collector health, rollup lake, raw lake, or app code
2. the concrete `request_id` or route involved
3. whether the request is root or propagated
4. whether the issue is ingestion, propagation, terminal detection, timeout, or app behavior
5. the smallest code or config change that would fix it
