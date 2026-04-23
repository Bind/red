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
REMOTE_URL="http://${GIT_SERVER_ADMIN_USERNAME:-admin}:${GIT_SERVER_ADMIN_PASSWORD:-admin}@grs:8080/${OWNER}/${NAME}.git"
DELIVERY_ID="preview:pr-${PR_NUMBER}:${HEAD_SHA}"

TMP_DIR="$(mktemp -d)"
PAYLOAD_DIR="${TMP_DIR}/payloads"
REPO_DIR="${TMP_DIR}/repo"

run_seed_git() {
  env -u GIT_DIR \
    -u GIT_WORK_TREE \
    -u GIT_INDEX_FILE \
    -u GIT_OBJECT_DIRECTORY \
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    git -C "${REPO_DIR}" "$@"
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

run_git_push() {
  local refspec="${1:?refspec required}"

  docker run --rm \
    --network "${PROJECT}_default" \
    -v "${REPO_DIR}:/repo" \
    -w /repo \
    alpine/git \
    sh -lc '
      git remote remove origin >/dev/null 2>&1 || true
      git remote add origin "'"${REMOTE_URL}"'"
      git push --force origin "'"${refspec}"'"
    '
}

echo "==> Ensuring preview repo ${REPO_ID} exists in ctl"
wait_for_http "api" "http://api:3000/health"
wait_for_grs
run_api_post "/api/repos" "${PAYLOAD_DIR}/create-repo.json" "201" "409"

echo "==> Seeding ${REPO_ID} base branch ${BASE_BRANCH}"
rsync -a --delete --exclude='.git' "${BASE_EXPORT_DIR}/" "${REPO_DIR}/"
run_seed_git init
run_seed_git config user.name "preview seeder"
run_seed_git config user.email "preview-seed@redc.local"
run_seed_git add -A
run_seed_git commit --allow-empty -m "seed ${BASE_BRANCH}"
run_seed_git branch -M "${BASE_BRANCH}"
run_git_push "HEAD:refs/heads/${BASE_BRANCH}"

echo "==> Seeding PR branch ${HEAD_BRANCH}"
rsync -a --delete --exclude='.git' "${HEAD_EXPORT_DIR}/" "${REPO_DIR}/"
run_seed_git checkout -B "${HEAD_BRANCH}"
run_seed_git add -A
if ! run_seed_git diff --cached --quiet; then
  run_seed_git commit -m "seed PR #${PR_NUMBER}"
fi
SEEDED_HEAD_SHA="$(run_seed_git rev-parse HEAD)"
run_git_push "HEAD:refs/heads/${HEAD_BRANCH}"

cat > "${PAYLOAD_DIR}/ingest-ref-update.json" <<EOF
{"repo":"${REPO_ID}","branch":"${HEAD_BRANCH}","base_branch":"${BASE_BRANCH}","head_sha":"${SEEDED_HEAD_SHA}","created_by":"human","delivery_id":"${DELIVERY_ID}","metadata":{"source":"preview_seed","pr_number":${PR_NUMBER},"preview_url":"${PREVIEW_URL}"}}
EOF

echo "==> Ingesting preview ref update for ${REPO_ID}@${HEAD_BRANCH}"
run_api_post "/api/ingest/ref-update" "${PAYLOAD_DIR}/ingest-ref-update.json" "201" "200"

echo "==> Preview repo ${REPO_ID} ready at ${PREVIEW_URL}"
