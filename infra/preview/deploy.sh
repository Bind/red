#!/usr/bin/env bash
set -euo pipefail

# Deploys the working tree to a per-PR preview stack on the dev box.
# The shared /opt/redc-previews/.env is produced once per deploy by decrypting
# .env.preview with DOTENV_PRIVATE_KEY_PREVIEW (kept in the box's shell profile).
# Compose then pulls immutable GHCR tags rather than building locally.
#
# Usage: ./infra/preview/deploy.sh <slug> <host> [ssh-port] <image-tag> <git-commit> <base-branch> <base-ref> <head-branch> <pr-number>

SLUG="${1:?Usage: $0 <slug> <host> [ssh-port]}"
HOST="${2:?Usage: $0 <slug> <host> [ssh-port]}"
SSH_PORT="${3:-2222}"
IMAGE_TAG="${4:?Usage: $0 <slug> <host> [ssh-port] <image-tag> <git-commit>}"
GIT_COMMIT="${5:?Usage: $0 <slug> <host> [ssh-port] <image-tag> <git-commit>}"
BASE_BRANCH="${6:?Usage: $0 <slug> <host> [ssh-port] <image-tag> <git-commit> <base-branch> <base-ref> <head-branch> <pr-number>}"
BASE_REF="${7:?Usage: $0 <slug> <host> [ssh-port] <image-tag> <git-commit> <base-branch> <base-ref> <head-branch> <pr-number>}"
HEAD_BRANCH="${8:?Usage: $0 <slug> <host> [ssh-port] <image-tag> <git-commit> <base-branch> <base-ref> <head-branch> <pr-number>}"
PR_NUMBER="${9:?Usage: $0 <slug> <host> [ssh-port] <image-tag> <git-commit> <base-branch> <base-ref> <head-branch> <pr-number>}"
REMOTE_DIR="/opt/redc-previews/${SLUG}"
PROJECT="preview-${SLUG}"
CADDY_SITES_DIR="/opt/redc-preview-caddy/caddy/sites"
CADDY_SITE_FILE="${CADDY_SITES_DIR}/${SLUG}.caddy"
PREVIEW_PUBLIC_URL="https://${SLUG}.preview.red.computer"
PREVIEW_WEB_CLIENTS="redc-web=${PREVIEW_PUBLIC_URL}"
PREVIEW_PASSKEY_ORIGINS="${PREVIEW_PUBLIC_URL}"
PREVIEW_PASSKEY_RP_IDS="preview.red.computer"
PREVIEW_HOSTED_REPO_ID="redc/red"
PREVIEW_REPO_OWNER="${PREVIEW_HOSTED_REPO_ID%%/*}"
MIN_FREE_KB=$((16 * 1024 * 1024))
SEED_TMP="$(mktemp -d)"
BASE_EXPORT_DIR="${SEED_TMP}/base"
HEAD_EXPORT_DIR="${SEED_TMP}/head"

cleanup() {
  rm -rf "${SEED_TMP}"
}
trap cleanup EXIT

mkdir -p "${BASE_EXPORT_DIR}" "${HEAD_EXPORT_DIR}"
git archive "${BASE_REF}" | tar -x -C "${BASE_EXPORT_DIR}"
git archive "${GIT_COMMIT}" | tar -x -C "${HEAD_EXPORT_DIR}"

echo "==> Ensuring remote dir ${REMOTE_DIR} exists"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" \
  "mkdir -p ${REMOTE_DIR}"

echo "==> Syncing working tree → ${HOST}:${REMOTE_DIR}"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .sst \
  --exclude .env \
  --exclude .env.keys \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  -e "ssh -p ${SSH_PORT} -o StrictHostKeyChecking=accept-new" \
  ./ "root@${HOST}:${REMOTE_DIR}/"

echo "==> Syncing preview seed snapshots → ${HOST}:${REMOTE_DIR}/.preview-seed"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" \
  "mkdir -p ${REMOTE_DIR}/.preview-seed/base ${REMOTE_DIR}/.preview-seed/head"
rsync -avz --delete \
  -e "ssh -p ${SSH_PORT} -o StrictHostKeyChecking=accept-new" \
  "${BASE_EXPORT_DIR}/" "root@${HOST}:${REMOTE_DIR}/.preview-seed/base/"
rsync -avz --delete \
  -e "ssh -p ${SSH_PORT} -o StrictHostKeyChecking=accept-new" \
  "${HEAD_EXPORT_DIR}/" "root@${HOST}:${REMOTE_DIR}/.preview-seed/head/"

echo "==> Decrypting .env.preview and pulling compose images (project=${PROJECT})"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" \
  IMAGE_TAG="${IMAGE_TAG}" GIT_COMMIT="${GIT_COMMIT}" \
  PREVIEW_PUBLIC_URL="${PREVIEW_PUBLIC_URL}" \
  PREVIEW_WEB_CLIENTS="${PREVIEW_WEB_CLIENTS}" \
  PREVIEW_PASSKEY_ORIGINS="${PREVIEW_PASSKEY_ORIGINS}" \
  PREVIEW_PASSKEY_RP_IDS="${PREVIEW_PASSKEY_RP_IDS}" \
  PREVIEW_HOSTED_REPO_ID="${PREVIEW_HOSTED_REPO_ID}" \
  PREVIEW_REPO_OWNER="${PREVIEW_REPO_OWNER}" \
  BASE_BRANCH="${BASE_BRANCH}" \
  HEAD_BRANCH="${HEAD_BRANCH}" \
  PR_NUMBER="${PR_NUMBER}" \
  "bash -s" <<REMOTE
set -euo pipefail

if [ -z "\${DOTENV_PRIVATE_KEY_PREVIEW:-}" ] && [ -f /root/.bashrc ]; then
  # Load just the persisted preview dotenvx key without evaluating interactive shell setup.
  preview_key_line=\$(grep -E '^export DOTENV_PRIVATE_KEY_PREVIEW=' /root/.bashrc | tail -n1 || true)
  if [ -n "\${preview_key_line}" ]; then
    export "\${preview_key_line#export }"
  fi
fi

cd "${REMOTE_DIR}"

if [ -z "\${DOTENV_PRIVATE_KEY_PREVIEW:-}" ]; then
  echo "error: DOTENV_PRIVATE_KEY_PREVIEW is not set on the host." >&2
  exit 1
fi

if ! command -v dotenvx >/dev/null 2>&1; then
  echo "==> Installing dotenvx"
  curl -fsS https://dotenvx.sh | sh
fi

# Shared /opt/redc-previews/.env is read by every preview's env_file.
# Regenerate it from the (possibly updated) encrypted source each deploy.
dotenvx decrypt -f .env.preview --stdout > /opt/redc-previews/.env
chmod 600 /opt/redc-previews/.env

set -a
. /opt/redc-previews/.env
set +a

if [ -n "\${GHCR_USERNAME:-}" ] && [ -n "\${GHCR_TOKEN:-}" ]; then
  printf '%s' "\${GHCR_TOKEN}" | docker login ghcr.io -u "\${GHCR_USERNAME}" --password-stdin
fi

preview_root="/var/lib/containerd"
if [ ! -d "\${preview_root}" ]; then
  preview_root="/"
fi
free_space_kb() {
  df -Pk "\${preview_root}" | awk 'NR==2 { print \$4 }'
}

prune_unused_docker_state() {
  echo "==> Pruning unused Docker state on \${preview_root}"
  docker system df || true
  COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/base/compose.yml -f infra/preview/compose.yml down --remove-orphans || true
  docker system prune -af --volumes || true
  docker builder prune -af || true
  free_kb=\$(free_space_kb)
  echo "==> Free space after prune: \${free_kb} KB"
}

ensure_preview_disk_headroom() {
  free_kb=\$(free_space_kb)
  if [ "\${free_kb:-0}" -lt "${MIN_FREE_KB}" ]; then
    echo "==> Low disk on \${preview_root} (\${free_kb} KB free; require ${MIN_FREE_KB} KB)"
    prune_unused_docker_state
    free_kb=\$(free_space_kb)
  fi

  if [ "\${free_kb:-0}" -lt "${MIN_FREE_KB}" ]; then
    echo "error: insufficient free space on \${preview_root} after prune (\${free_kb} KB free; require ${MIN_FREE_KB} KB)" >&2
    exit 1
  fi
}

compose_pull_with_recovery() {
  pull_log=\$(mktemp)
  if COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/base/compose.yml -f infra/preview/compose.yml pull 2>&1 | tee "\${pull_log}"; then
    rm -f "\${pull_log}"
    return 0
  fi

  if grep -q "no space left on device" "\${pull_log}"; then
    echo "==> Compose pull hit ENOSPC; pruning and retrying once"
    prune_unused_docker_state
    ensure_preview_disk_headroom
    COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/base/compose.yml -f infra/preview/compose.yml pull
    rm -f "\${pull_log}"
    return 0
  fi

  rm -f "\${pull_log}"
  return 1
}

ensure_preview_disk_headroom

export IMAGE_TAG GIT_COMMIT PREVIEW_PUBLIC_URL PREVIEW_WEB_CLIENTS PREVIEW_PASSKEY_ORIGINS PREVIEW_PASSKEY_RP_IDS PREVIEW_HOSTED_REPO_ID PREVIEW_REPO_OWNER
compose_pull_with_recovery
COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/base/compose.yml -f infra/preview/compose.yml up -d

"${REMOTE_DIR}/infra/preview/seed.sh" \
  "${PROJECT}" \
  "${REMOTE_DIR}" \
  "${PREVIEW_HOSTED_REPO_ID}" \
  "${BASE_BRANCH}" \
  "${HEAD_BRANCH}" \
  "${PR_NUMBER}" \
  "${GIT_COMMIT}" \
  "${PREVIEW_PUBLIC_URL}"

mkdir -p "${CADDY_SITES_DIR}"
cat > "${CADDY_SITE_FILE}" <<CADDY
${SLUG}.preview.red.computer {
    reverse_proxy ${PROJECT}-gateway:8080 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        lb_try_duration 2s
        fail_duration 10s
    }

    handle_errors {
        @bad_gateway expression {http.error.status_code} == 502
        respond @bad_gateway "preview ${SLUG} is not running" 404
        respond "preview ${SLUG} is unhealthy" {http.error.status_code}
    }
}
CADDY

docker exec preview-caddy caddy reload --config /etc/caddy/preview.Caddyfile
REMOTE

echo "==> Deployed preview ${SLUG} → https://${SLUG}.preview.red.computer"
