#!/usr/bin/env bash
set -euo pipefail

# Seed the production hosted repo into ctl + GRS so the homepage and hosted-repo
# views can read the same fork preview uses.

REPO_ID="${PROD_HOSTED_REPO_ID:-bind/red}"
DEFAULT_BRANCH="${PROD_HOSTED_REPO_DEFAULT_BRANCH:-main}"
REMOTE_URL="${PROD_HOSTED_REPO_REMOTE_URL:-https://github.com/${REPO_ID}.git}"
VISIBILITY="${PROD_HOSTED_REPO_VISIBILITY:-public}"

OWNER="${REPO_ID%%/*}"
NAME="${REPO_ID#*/}"
TMP_DIR="$(mktemp -d)"
REPO_DIR="${TMP_DIR}/repo"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

wait_for_compose_service() {
  local label="${1:?label required}"
  local url="${2:?url required}"
  local attempts="${3:-30}"
  local network="${4:?network required}"

  for _attempt in $(seq 1 "${attempts}"); do
    if docker run --rm --network "${network}" curlimages/curl:8.7.1 \
      sh -lc 'curl -fsS "'"${url}"'" >/dev/null'; then
      return 0
    fi
    sleep 2
  done

  echo "error: timed out waiting for ${label} at ${url}" >&2
  return 1
}

run_api_post() {
  local network="${1:?network required}"
  local path="${2:?path required}"
  local payload_file="${3:?payload file required}"
  local expected_primary="${4:?primary status required}"
  local expected_secondary="${5:-}"

  docker run --rm \
    --network "${network}" \
    -v "${payload_file}:/payload.json:ro" \
    curlimages/curl:8.7.1 \
    sh -lc '
      status="$(curl -sS -o /tmp/out -w "%{http_code}" \
        -H "content-type: application/json" \
        -X POST "http://api:3000'"${path}"'" \
        --data @/payload.json)"
      if [ "$status" != "'"${expected_primary}"'" ] && [ -n "'"${expected_secondary}"'" ] && [ "$status" != "'"${expected_secondary}"'" ]; then
        cat /tmp/out >&2
        exit 1
      fi
      if [ "$status" != "'"${expected_primary}"'" ] && [ -z "'"${expected_secondary}"'" ]; then
        cat /tmp/out >&2
        exit 1
      fi
    ' >/dev/null
}

ensure_minio_buckets() {
  local network="${1:?network required}"
  docker run --rm \
    --network "${network}" \
    --entrypoint /bin/sh \
    -e MINIO_ENDPOINT="s3" \
    -e MINIO_PORT="9000" \
    -e MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}" \
    -e MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}" \
    -e MINIO_BUCKET="${MINIO_BUCKET:-red-artifacts}" \
    -e GIT_SERVER_S3_BUCKET="${GIT_SERVER_S3_BUCKET:-grs-repos}" \
    -e WIDE_EVENTS_RAW_BUCKET="${WIDE_EVENTS_RAW_BUCKET:-wide-events-raw}" \
    -e WIDE_EVENTS_ROLLUP_BUCKET="${WIDE_EVENTS_ROLLUP_BUCKET:-wide-events-rollup}" \
    minio/mc:latest \
    -c '
      until mc alias set local "http://$MINIO_ENDPOINT:$MINIO_PORT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"; do
        sleep 1
      done &&
      mc mb --ignore-existing "local/$MINIO_BUCKET" &&
      mc mb --ignore-existing "local/$GIT_SERVER_S3_BUCKET" &&
      mc mb --ignore-existing "local/$WIDE_EVENTS_RAW_BUCKET" &&
      mc mb --ignore-existing "local/$WIDE_EVENTS_ROLLUP_BUCKET"
    '
}

mkdir -p "${REPO_DIR}"

echo "==> Resolving production compose network"
GRS_CONTAINER_ID="$(
  docker compose --env-file .env -f infra/base/compose.yml -f infra/prod/compose.yml ps -q grs
)"
if [ -z "${GRS_CONTAINER_ID}" ]; then
  echo "error: grs container is not running" >&2
  exit 1
fi

COMPOSE_NETWORK="$(
  docker inspect "${GRS_CONTAINER_ID}" \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
    | head -n1
)"
if [ -z "${COMPOSE_NETWORK}" ]; then
  echo "error: unable to resolve compose network for grs" >&2
  exit 1
fi

echo "==> Waiting for ctl + grs to become reachable"
wait_for_compose_service "api" "http://api:3000/health" 30 "${COMPOSE_NETWORK}"
wait_for_compose_service "grs" "http://grs:8080/health" 30 "${COMPOSE_NETWORK}"
wait_for_compose_service "s3" "http://s3:9000/minio/health/live" 30 "${COMPOSE_NETWORK}"
ensure_minio_buckets "${COMPOSE_NETWORK}"

echo "==> Ensuring repo record ${REPO_ID} exists in ctl"
cat > "${TMP_DIR}/create-repo.json" <<EOF
{"owner":"${OWNER}","name":"${NAME}","default_branch":"${DEFAULT_BRANCH}","visibility":"${VISIBILITY}"}
EOF
run_api_post "${COMPOSE_NETWORK}" "/api/repos" "${TMP_DIR}/create-repo.json" "201" "409"

echo "==> Cloning ${REMOTE_URL}#${DEFAULT_BRANCH}"
git clone --depth=100 --branch "${DEFAULT_BRANCH}" "${REMOTE_URL}" "${REPO_DIR}"

echo "==> Pushing ${REPO_ID}@${DEFAULT_BRANCH} into prod GRS"
docker run --rm \
  --network "${COMPOSE_NETWORK}" \
  -v "${REPO_DIR}:/repo" \
  -e GIT_SERVER_ADMIN_USERNAME="${GIT_SERVER_ADMIN_USERNAME:-admin}" \
  -e GIT_SERVER_ADMIN_PASSWORD="${GIT_SERVER_ADMIN_PASSWORD:-admin}" \
  -e REPO_OWNER="${OWNER}" \
  -e REPO_NAME="${NAME}" \
  -e DEFAULT_BRANCH="${DEFAULT_BRANCH}" \
  alpine/git \
  sh -lc '
    set -euo pipefail
    auth="$(printf "%s" "$GIT_SERVER_ADMIN_USERNAME:$GIT_SERVER_ADMIN_PASSWORD" | base64 | tr -d "\n")"
    git -C /repo \
      -c safe.directory=/repo \
      -c http.extraHeader="Authorization: Basic $auth" \
      push --force "http://grs:8080/${REPO_OWNER}/${REPO_NAME}.git" \
      "refs/heads/${DEFAULT_BRANCH}:refs/heads/${DEFAULT_BRANCH}"
  '

echo "==> Production hosted repo ${REPO_ID} is seeded"
