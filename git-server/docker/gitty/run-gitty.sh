#!/usr/bin/env bash
set -euo pipefail

PORT="${GIT_SERVER_PORT:-8080}"

echo "starting git server on :${PORT}"
cd /app
exec bun run src/core/minio-server.ts
