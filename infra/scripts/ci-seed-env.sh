#!/usr/bin/env bash
# Writes a CI .env for the service-health compose-smoke job.
# Call: ./infra/scripts/ci-seed-env.sh <git-sha>
set -euo pipefail

SHA="${1:?usage: $0 <git-sha>}"

cat > .env <<EOF
GIT_COMMIT=${SHA}
WIDE_EVENTS_HOST=0.0.0.0
WIDE_EVENTS_PORT=4090
WIDE_EVENTS_STORAGE_BACKEND=file
WIDE_EVENTS_DATA_DIR=/data/wide-events
WIDE_EVENTS_RAW_EVENTS_DIR=/data/wide-events/raw
WIDE_EVENTS_ROLLUP_DIR=/data/wide-events/rollup
WIDE_EVENTS_RAW_BUCKET=wide-events-raw
WIDE_EVENTS_RAW_PREFIX=raw
WIDE_EVENTS_ROLLUP_BUCKET=wide-events-rollup
WIDE_EVENTS_ROLLUP_PREFIX=rollup
WIDE_EVENTS_SWEEP_INTERVAL_MS=5000
WIDE_EVENTS_INCOMPLETE_GRACE_MS=60000
WIDE_EVENTS_REPLAY_WINDOW_MS=600000
WIDE_EVENTS_S3_ENDPOINT=http://s3:9000
WIDE_EVENTS_S3_REGION=us-east-1
WIDE_EVENTS_S3_ACCESS_KEY_ID=minioadmin
WIDE_EVENTS_S3_SECRET_ACCESS_KEY=minioadmin
EOF
