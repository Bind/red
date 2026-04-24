#!/usr/bin/env bash
set -euo pipefail

PROJECT="${1:?Usage: $0 <project> <remote-dir> <repo-id> <base-branch> <head-branch> <pr-number> <head-sha> <preview-url>}"
REMOTE_DIR="${2:?Usage: $0 <project> <remote-dir> <repo-id> <base-branch> <head-branch> <pr-number> <head-sha> <preview-url>}"
REPO_ID="${3:?Usage: $0 <project> <remote-dir> <repo-id> <base-branch> <head-branch> <pr-number> <head-sha> <preview-url>}"
BASE_BRANCH="${4:?Usage: $0 <project> <remote-dir> <repo-id> <base-branch> <head-branch> <pr-number> <head-sha> <preview-url>}"
HEAD_BRANCH="${5:?Usage: $0 <project> <remote-dir> <repo-id> <base-branch> <head-branch> <pr-number> <head-sha> <preview-url>}"
PR_NUMBER="${6:?Usage: $0 <project> <remote-dir> <repo-id> <base-branch> <head-branch> <pr-number> <head-sha> <preview-url>}"
HEAD_SHA="${7:?Usage: $0 <project> <remote-dir> <repo-id> <base-branch> <head-branch> <pr-number> <head-sha> <preview-url>}"
PREVIEW_URL="${8:?Usage: $0 <project> <remote-dir> <repo-id> <base-branch> <head-branch> <pr-number> <head-sha> <preview-url>}"

BASE_EXPORT_DIR="${REMOTE_DIR}/.preview-seed/base"
HEAD_EXPORT_DIR="${REMOTE_DIR}/.preview-seed/head"
OWNER="${REPO_ID%%/*}"
NAME="${REPO_ID#*/}"
DELIVERY_ID="preview:pr-${PR_NUMBER}:${HEAD_SHA}"

TMP_DIR="$(mktemp -d)"
PAYLOAD_DIR="${TMP_DIR}/payloads"
REPO_DIR="${TMP_DIR}/repo"
REPO_DIR_REAL=""
MINIO_BUCKET_NAME="${MINIO_BUCKET:-redc-artifacts}"
GIT_SERVER_BUCKET_NAME="${GIT_SERVER_S3_BUCKET:-grs-repos}"
WIDE_EVENTS_RAW_BUCKET_NAME="${WIDE_EVENTS_RAW_BUCKET:-wide-events-raw}"
WIDE_EVENTS_ROLLUP_BUCKET_NAME="${WIDE_EVENTS_ROLLUP_BUCKET:-wide-events-rollup}"

run_seed_git() {
  env -i \
    PATH="${PATH}" \
    HOME="${HOME}" \
    USER="${USER:-root}" \
    LANG="${LANG:-C.UTF-8}" \
    git -C "${REPO_DIR}" "$@"
}

build_push_remote_url() {
  local actor_id="${1:?actor id required}"

  if ! command -v python3 >/dev/null 2>&1; then
    echo "error: python3 is required to generate repo-scoped git credentials" >&2
    return 1
  fi

  REPO_ID="${REPO_ID}" \
  ACTOR_ID="${actor_id}" \
  TOKEN_SECRET="${GIT_SERVER_AUTH_TOKEN_SECRET:?GIT_SERVER_AUTH_TOKEN_SECRET is required}" \
  python3 - <<'PY'
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse

repo_id = os.environ["REPO_ID"]
actor_id = os.environ["ACTOR_ID"]
secret = os.environ["TOKEN_SECRET"].encode("utf-8")
exp = int(time.time()) + 300
payload = {
    "v": 1,
    "sub": actor_id,
    "repoId": repo_id,
    "access": "write",
    "exp": exp,
}
payload_json = json.dumps(payload, separators=(",", ":")).encode("utf-8")
encoded_payload = base64.urlsafe_b64encode(payload_json).rstrip(b"=").decode("ascii")
signature = hmac.new(secret, encoded_payload.encode("utf-8"), hashlib.sha256).digest()
encoded_signature = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
token = f"{encoded_payload}.{encoded_signature}"
username = urllib.parse.quote(actor_id, safe="")
password = urllib.parse.quote(token, safe="")
owner, name = repo_id.split("/", 1)
print(f"http://{username}:{password}@grs:8080/{owner}/{name}.git")
PY
}

bootstrap_seed_repo() {
  REPO_DIR_REAL="$(cd "${REPO_DIR}" && pwd -P)"

  env -i \
    PATH="${PATH}" \
    HOME="${HOME}" \
    USER="${USER:-root}" \
    LANG="${LANG:-C.UTF-8}" \
    git config --global --add safe.directory "${REPO_DIR_REAL}"

  run_seed_git init
  run_seed_git branch -M "${BASE_BRANCH}"
}

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${PAYLOAD_DIR}" "${REPO_DIR}"

cat > "${PAYLOAD_DIR}/create-repo.json" <<EOF
{"owner":"${OWNER}","name":"${NAME}","default_branch":"${BASE_BRANCH}","visibility":"private"}
EOF

run_api_post() {
  local path="${1:?path required}"
  local payload_file="${2:?payload file required}"
  local expected_primary="${3:?primary status required}"
  local expected_secondary="${4:-}"

  docker run --rm \
    --network "${PROJECT}_default" \
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
      cat /tmp/out
    ' >/dev/null
}

wait_for_http() {
  local name="${1:?name required}"
  local url="${2:?url required}"
  local attempts="${3:-30}"

  for attempt in $(seq 1 "${attempts}"); do
    if docker run --rm --network "${PROJECT}_default" curlimages/curl:8.7.1 \
      sh -lc 'curl -fsS "'"${url}"'" >/dev/null'; then
      return 0
    fi
    sleep 2
  done

  echo "error: timed out waiting for ${name} at ${url}" >&2
  return 1
}

wait_for_s3() {
  local attempts="${1:-30}"
  local endpoint="http://s3:9000/minio/health/live"

  for attempt in $(seq 1 "${attempts}"); do
    if docker run --rm --network "${PROJECT}_default" curlimages/curl:8.7.1 \
      sh -lc 'curl -fsS "'"${endpoint}"'" >/dev/null'; then
      return 0
    fi
    sleep 2
  done

  echo "error: timed out waiting for s3 at ${endpoint}" >&2
  return 1
}

wait_for_grs() {
  local attempts="${1:-30}"
  local username="${GIT_SERVER_ADMIN_USERNAME:-admin}"
  local password="${GIT_SERVER_ADMIN_PASSWORD:-admin}"
  local url="http://grs:8080/redc/__healthcheck__.git/info/refs?service=git-upload-pack"

  for attempt in $(seq 1 "${attempts}"); do
    status="$(
      docker run --rm --network "${PROJECT}_default" curlimages/curl:8.7.1 \
        sh -lc 'curl -sS -o /dev/null -w "%{http_code}" -u "'"${username}:${password}"'" "'"${url}"'"' \
        2>/dev/null || true
    )"
    if [ -n "${status}" ] && [ "${status}" -lt 500 ]; then
      return 0
    fi
    sleep 2
  done

  echo "error: timed out waiting for git server smart-http route" >&2
  return 1
}

ensure_minio_buckets() {
  docker run --rm \
    --network "${PROJECT}_default" \
    --entrypoint /bin/sh \
    -e MINIO_ENDPOINT="s3" \
    -e MINIO_PORT="9000" \
    -e MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}" \
    -e MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}" \
    -e MINIO_BUCKET="${MINIO_BUCKET_NAME}" \
    -e GIT_SERVER_S3_BUCKET="${GIT_SERVER_BUCKET_NAME}" \
    -e WIDE_EVENTS_RAW_BUCKET="${WIDE_EVENTS_RAW_BUCKET_NAME}" \
    -e WIDE_EVENTS_ROLLUP_BUCKET="${WIDE_EVENTS_ROLLUP_BUCKET_NAME}" \
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

run_git_push() {
  local refspec="${1:?refspec required}"
  local remote_url="${2:?remote url required}"

  docker run --rm \
    --network "${PROJECT}_default" \
    -v "${REPO_DIR}:/repo" \
    alpine/git \
    -c safe.directory=/repo \
    -C /repo \
    push --force "${remote_url}" "${refspec}"
}

echo "==> Ensuring preview repo ${REPO_ID} exists in ctl"
wait_for_http "api" "http://api:3000/health"
wait_for_s3
ensure_minio_buckets
wait_for_grs
run_api_post "/api/repos" "${PAYLOAD_DIR}/create-repo.json" "201" "409"
PUSH_REMOTE_URL="$(build_push_remote_url "preview-seeder")"

echo "==> Seeding ${REPO_ID} base branch ${BASE_BRANCH}"
rsync -a --delete --exclude='.git' "${BASE_EXPORT_DIR}/" "${REPO_DIR}/"
bootstrap_seed_repo
run_seed_git config user.name "preview seeder"
run_seed_git config user.email "preview-seed@redc.local"
run_seed_git add -A
run_seed_git commit --allow-empty -m "seed ${BASE_BRANCH}"
run_git_push "HEAD:refs/heads/${BASE_BRANCH}" "${PUSH_REMOTE_URL}"

echo "==> Seeding PR branch ${HEAD_BRANCH}"
rsync -a --delete --exclude='.git' "${HEAD_EXPORT_DIR}/" "${REPO_DIR}/"
run_seed_git checkout -B "${HEAD_BRANCH}"
run_seed_git add -A
if ! run_seed_git diff --cached --quiet; then
  run_seed_git commit -m "seed PR #${PR_NUMBER}"
fi
SEEDED_HEAD_SHA="$(run_seed_git rev-parse HEAD)"
run_git_push "HEAD:refs/heads/${HEAD_BRANCH}" "${PUSH_REMOTE_URL}"

cat > "${PAYLOAD_DIR}/ingest-ref-update.json" <<EOF
{"repo":"${REPO_ID}","branch":"${HEAD_BRANCH}","base_branch":"${BASE_BRANCH}","head_sha":"${SEEDED_HEAD_SHA}","created_by":"human","delivery_id":"${DELIVERY_ID}","metadata":{"source":"preview_seed","pr_number":${PR_NUMBER},"preview_url":"${PREVIEW_URL}"}}
EOF

echo "==> Ingesting preview ref update for ${REPO_ID}@${HEAD_BRANCH}"
run_api_post "/api/ingest/ref-update" "${PAYLOAD_DIR}/ingest-ref-update.json" "201" "200"

echo "==> Preview repo ${REPO_ID} ready at ${PREVIEW_URL}"
