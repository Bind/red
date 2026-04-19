#!/usr/bin/env bash
set -euo pipefail

# Deploys the working tree to a per-PR preview stack on the dev box.
# The shared /opt/redc-previews/.env is produced once per deploy by decrypting
# .env.preview with DOTENV_PRIVATE_KEY_PREVIEW (kept in the box's shell profile).
#
# Usage: ./infra/scripts/deploy-preview.sh <slug> <host> [ssh-port]

SLUG="${1:?Usage: $0 <slug> <host> [ssh-port]}"
HOST="${2:?Usage: $0 <slug> <host> [ssh-port]}"
SSH_PORT="${3:-2222}"
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

echo "==> Decrypting .env.preview and bringing up compose (project=${PROJECT})"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" "bash -s" <<REMOTE
set -euo pipefail
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
dotenvx decrypt -f .env.preview -o /opt/redc-previews/.env
chmod 600 /opt/redc-previews/.env

COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/compose/preview.yml up -d --build
REMOTE

echo "==> Deployed preview ${SLUG} → https://${SLUG}.preview.red.computer"
