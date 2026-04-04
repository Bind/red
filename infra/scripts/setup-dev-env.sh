#!/usr/bin/env bash
set -euo pipefail

REDC_PORT="${REDC_PORT:-3000}"
REDC_DB_PATH="${REDC_DB_PATH:-/data/redc-dev.db}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_USE_SSL="${MINIO_USE_SSL:-false}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
MINIO_BUCKET="${MINIO_BUCKET:-redc-artifacts}"
MINIO_PREFIX="${MINIO_PREFIX:-claw-runs}"
MINIO_API_PORT="${MINIO_API_PORT:-9003}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9002}"
GIT_STORAGE_PUBLIC_URL="${GIT_STORAGE_PUBLIC_URL:-http://git-server:8080}"
GIT_STORAGE_DEFAULT_OWNER="${GIT_STORAGE_DEFAULT_OWNER:-redc}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/dev.yml}"

mkdir -p apps/auth/compose
if [[ ! -f apps/auth/compose/signing-key.private.jwk ]]; then
  echo "Generating auth signing key..."
  (
    cd apps/auth && \
      bun --eval 'import { writeFileSync } from "node:fs"; import { generateKeyPairSync } from "node:crypto"; import { exportJWK } from "jose"; const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); const jwk = await exportJWK(privateKey); writeFileSync("compose/signing-key.private.jwk", `${JSON.stringify(jwk, null, 2)}\n`);'
  )
fi

echo "Writing .env..."
cat > .env <<EOF
REPO_PROVIDER=git_storage
GIT_STORAGE_PUBLIC_URL=$GIT_STORAGE_PUBLIC_URL
GIT_STORAGE_DEFAULT_OWNER=$GIT_STORAGE_DEFAULT_OWNER
REDC_PORT=$REDC_PORT
REDC_DB_PATH=$REDC_DB_PATH
CLAW_RUNNER_IMAGE=redc-claw-runner
MINIO_ENDPOINT=$MINIO_ENDPOINT
MINIO_PORT=$MINIO_PORT
MINIO_USE_SSL=$MINIO_USE_SSL
MINIO_ACCESS_KEY=$MINIO_ACCESS_KEY
MINIO_SECRET_KEY=$MINIO_SECRET_KEY
MINIO_BUCKET=$MINIO_BUCKET
MINIO_PREFIX=$MINIO_PREFIX
MINIO_API_PORT=$MINIO_API_PORT
MINIO_CONSOLE_PORT=$MINIO_CONSOLE_PORT
EOF

echo "Building Claw runner image..."
docker build -t redc-claw-runner tools/claw-runner/

echo "Starting dev stack..."
docker compose -f "$COMPOSE_FILE" up -d --build minio minio-init git-server auth-db auth api bff web

echo ""
echo "=== Setup complete ==="
echo "UI:      http://localhost:5173"
echo "API:     http://localhost:3000"
echo "BFF:     http://localhost:3001"
echo "Auth:    http://localhost:4020"
echo "Git:     http://localhost:9080"
echo "MinIO:   http://localhost:$MINIO_CONSOLE_PORT"
echo "S3 API:  http://localhost:$MINIO_API_PORT"
