#!/usr/bin/env bash
set -euo pipefail

FORGEJO_URL="${FORGEJO_URL:-http://localhost:3001}"
FORGEJO_ADMIN="${FORGEJO_ADMIN:-redc-admin}"
FORGEJO_PASS="${FORGEJO_PASS:-admin1234}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dev-secret-123}"
REDC_PORT="${REDC_PORT:-3002}"
TEST_REPO="${TEST_REPO:-test-repo}"
REDC_DB_PATH="${REDC_DB_PATH:-/data/redc-dev.db}"
FORGEJO_WAIT_SECONDS="${FORGEJO_WAIT_SECONDS:-90}"
FORGEJO_INTERNAL_URL="${FORGEJO_INTERNAL_URL:-http://forgejo:3000}"
MINIO_ENDPOINT="${MINIO_ENDPOINT:-minio}"
MINIO_PORT="${MINIO_PORT:-9000}"
MINIO_USE_SSL="${MINIO_USE_SSL:-false}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
MINIO_BUCKET="${MINIO_BUCKET:-redc-artifacts}"
MINIO_PREFIX="${MINIO_PREFIX:-claw-runs}"
MINIO_API_PORT="${MINIO_API_PORT:-9003}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-9002}"

COMPOSE_FILE="${COMPOSE_FILE:-infra/compose/dev.yml}"

docker compose -f "$COMPOSE_FILE" up -d forgejo minio
docker compose -f "$COMPOSE_FILE" run --rm minio-init > /dev/null

echo "Waiting for Forgejo..."
for i in $(seq 1 "$FORGEJO_WAIT_SECONDS"); do
  if docker compose -f "$COMPOSE_FILE" exec -T forgejo wget -q -O - http://127.0.0.1:3000/api/v1/version > /dev/null 2>&1; then
    echo "  Forgejo is up (container)"
    break
  fi
  if curl -sf "$FORGEJO_URL/api/v1/version" > /dev/null 2>&1; then
    echo "  Forgejo is up (host)"
    break
  fi
  if [ "$i" -eq "$FORGEJO_WAIT_SECONDS" ]; then
    echo "ERROR: Forgejo did not become ready"
    docker compose -f "$COMPOSE_FILE" ps forgejo || true
    docker compose -f "$COMPOSE_FILE" logs --tail=50 forgejo || true
    exit 1
  fi
  sleep 1
done

echo "Creating admin user..."
docker compose -f "$COMPOSE_FILE" exec -T forgejo su -c \
  "forgejo admin user create --username \"$FORGEJO_ADMIN\" --password \"$FORGEJO_PASS\" --email \"admin@redc.local\" --admin --must-change-password=false" \
  git 2>/dev/null \
  || echo "  (user may already exist)"

forgejo_token=""
if [ -f .env ]; then
  forgejo_token="$(grep '^FORGEJO_TOKEN=' .env | head -n1 | cut -d'=' -f2- || true)"
fi

if [ -n "$forgejo_token" ]; then
  echo "Reusing API token from .env..."
  echo "  Token: ${forgejo_token:0:8}..."
else
  echo "Creating API token..."
  token_response="$(curl -sf -X POST "$FORGEJO_URL/api/v1/users/$FORGEJO_ADMIN/tokens" \
    -u "$FORGEJO_ADMIN:$FORGEJO_PASS" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"redc-dev-$(date +%s)\",\"scopes\":[\"all\"]}")"

  forgejo_token="$(echo "$token_response" | grep -o '"sha1":"[^"]*"' | cut -d'"' -f4)"
  if [ -z "$forgejo_token" ]; then
    echo "ERROR: Failed to create token. Response: $token_response"
    exit 1
  fi
  echo "  Token: ${forgejo_token:0:8}..."
fi

echo "Creating test repo..."
curl -sf -X POST "$FORGEJO_URL/api/v1/user/repos" \
  -H "Authorization: token $forgejo_token" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$TEST_REPO\",\"auto_init\":true,\"default_branch\":\"main\"}" > /dev/null 2>&1 \
  || echo "  (repo may already exist)"

echo "Creating webhook..."
curl -sf -X POST "$FORGEJO_URL/api/v1/repos/$FORGEJO_ADMIN/$TEST_REPO/hooks" \
  -H "Authorization: token $forgejo_token" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"forgejo\",
    \"active\": true,
    \"config\": {
      \"url\": \"http://api:$REDC_PORT/webhook/push\",
      \"content_type\": \"json\",
      \"secret\": \"$WEBHOOK_SECRET\"
    },
    \"events\": [\"push\"]
  }" > /dev/null 2>&1 \
  || echo "  (webhook may already exist)"

echo "Writing .env..."
cat > .env <<EOF
FORGEJO_URL=$FORGEJO_INTERNAL_URL
FORGEJO_TOKEN=$forgejo_token
WEBHOOK_SECRET=$WEBHOOK_SECRET
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

echo "Starting app containers..."
docker compose -f "$COMPOSE_FILE" up -d --build api web

echo ""
echo "=== Setup complete ==="
echo "UI:      http://localhost:5173"
echo "API:     http://localhost:3000"
echo "Forgejo: http://localhost:3001"
echo "MinIO:   http://localhost:$MINIO_CONSOLE_PORT"
echo "S3 API:  http://localhost:$MINIO_API_PORT"
