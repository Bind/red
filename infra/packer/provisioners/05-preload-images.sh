#!/usr/bin/env bash
set -euo pipefail

echo "==> preloading base container images"

# Pull each image once so the first `docker compose up` on a new box skips
# these roundtrips. The list covers every prod + preview dependency that
# pins a public image rather than building locally.
images=(
  "oven/bun:1"
  "oven/bun:1-alpine"
  "node:22-slim"
  "nginx:1.27-alpine"
  "caddy:2-alpine"
  "minio/minio:latest"
  "minio/mc:latest"
  "postgres:16-alpine"
  "envoyproxy/envoy:v1.32-latest"
)

for img in "${images[@]}"; do
  echo "  docker pull $img"
  docker pull "$img"
done
