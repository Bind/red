#!/usr/bin/env bash
set -euo pipefail

compose_file="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.yml"
export WIDE_EVENTS_S3_ACCESS_KEY_ID="${WIDE_EVENTS_S3_ACCESS_KEY_ID:-minioadmin}"
export WIDE_EVENTS_S3_SECRET_ACCESS_KEY="${WIDE_EVENTS_S3_SECRET_ACCESS_KEY:-minioadmin}"
export WIDE_EVENTS_LAB_PORT="${WIDE_EVENTS_LAB_PORT:-4090}"

docker compose -f "$compose_file" up --build -d minio minio-init collector
cleanup() {
  docker compose -f "$compose_file" down -v --remove-orphans
}
trap cleanup EXIT

until curl -fsS "http://127.0.0.1:${WIDE_EVENTS_LAB_PORT}/health" >/dev/null; do
  sleep 1
done

curl -fsS -X POST "http://127.0.0.1:${WIDE_EVENTS_LAB_PORT}/v1/events" \
  -H 'content-type: application/json' \
  -d '{
    "sent_at":"2026-04-08T14:00:00.000Z",
    "source":{"service":"api"},
    "events":[
      {
        "event_id":"evt-e2e-1",
        "request_id":"req-e2e-1",
        "service":"api",
        "kind":"request.received",
        "ts":"2026-04-08T14:00:00.000Z",
        "data":{"request":{"method":"GET","path":"/health"}}
      },
      {
        "event_id":"evt-e2e-2",
        "request_id":"req-e2e-1",
        "service":"api",
        "kind":"request.completed",
        "ts":"2026-04-08T14:00:00.010Z",
        "status_code":200,
        "outcome":"ok",
        "data":{}
      }
    ]
  }' >/dev/null

docker compose -f "$compose_file" run --rm minio-init /bin/sh -lc '
  mc alias set local "$WIDE_EVENTS_S3_ENDPOINT" "$WIDE_EVENTS_S3_ACCESS_KEY_ID" "$WIDE_EVENTS_S3_SECRET_ACCESS_KEY" >/dev/null &&
  mc find local/"$WIDE_EVENTS_RAW_BUCKET" | grep req-e2e >/dev/null || mc cat local/"$WIDE_EVENTS_RAW_BUCKET"/raw/date=2026-04-08/service=api/* | grep "\"request_id\":\"req-e2e-1\"" >/dev/null
'

docker compose -f "$compose_file" run --rm minio-init /bin/sh -lc '
  mc alias set local "$WIDE_EVENTS_S3_ENDPOINT" "$WIDE_EVENTS_S3_ACCESS_KEY_ID" "$WIDE_EVENTS_S3_SECRET_ACCESS_KEY" >/dev/null &&
  mc cat local/"$WIDE_EVENTS_ROLLUP_BUCKET"/rollup/date=2026-04-08/hour=14/* | grep "\"request_id\":\"req-e2e-1\"" >/dev/null
'
