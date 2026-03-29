#!/usr/bin/env bash
set -euo pipefail

SERVER_IP="${1:?Usage: ./scripts/deploy.sh <server-ip>}"
SSH_PORT="${2:-2222}"
REMOTE_DIR="/opt/redc"

echo "==> Syncing files to ${SERVER_IP}..."
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .sst \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  -e "ssh -p ${SSH_PORT}" \
  ./ "root@${SERVER_IP}:${REMOTE_DIR}/"

echo "==> Building and starting containers..."
ssh -p "${SSH_PORT}" "root@${SERVER_IP}" \
  "cd ${REMOTE_DIR} && docker compose -f docker-compose.prod.yml up -d --build"

echo "==> Deployed successfully!"
echo "    https://red.computer"
