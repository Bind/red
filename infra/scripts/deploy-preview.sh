#!/usr/bin/env bash
set -euo pipefail

# Deploys the working tree to a per-PR preview stack on the dev box.
# The shared /opt/redc-previews/.env is produced once per deploy by decrypting
# .env.preview with DOTENV_PRIVATE_KEY_PREVIEW (kept in the box's shell profile).
# Compose then pulls immutable GHCR tags rather than building locally.
#
# Usage: ./infra/scripts/deploy-preview.sh <slug> <host> [ssh-port] <image-tag> <git-commit>

SLUG="${1:?Usage: $0 <slug> <host> [ssh-port]}"
HOST="${2:?Usage: $0 <slug> <host> [ssh-port]}"
SSH_PORT="${3:-2222}"
IMAGE_TAG="${4:?Usage: $0 <slug> <host> [ssh-port] <image-tag> <git-commit>}"
GIT_COMMIT="${5:?Usage: $0 <slug> <host> [ssh-port] <image-tag> <git-commit>}"
REMOTE_DIR="/opt/redc-previews/${SLUG}"
PROJECT="preview-${SLUG}"

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

echo "==> Decrypting .env.preview and pulling compose images (project=${PROJECT})"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" \
  IMAGE_TAG="${IMAGE_TAG}" GIT_COMMIT="${GIT_COMMIT}" "bash -s" <<REMOTE
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

export IMAGE_TAG GIT_COMMIT
COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/compose/preview.yml pull
COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/compose/preview.yml up -d
REMOTE

echo "==> Deployed preview ${SLUG} → https://${SLUG}.preview.red.computer"
