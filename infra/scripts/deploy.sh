#!/usr/bin/env bash
set -euo pipefail

# Deploys the current working tree to the Hetzner host via rsync + ssh.
# Leaves server-owned state alone: .env, docker volumes, database files.
#
# Usage: ./infra/scripts/deploy.sh <host> [ssh-port]

HOST="${1:?Usage: $0 <host> [ssh-port]}"
SSH_PORT="${2:-2222}"
REMOTE_DIR="/opt/redc"
COMPOSE_FILE="infra/compose/prod.yml"

echo "==> Syncing files to ${HOST} (port ${SSH_PORT})"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .sst \
  --exclude .env \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  -e "ssh -p ${SSH_PORT} -o StrictHostKeyChecking=accept-new" \
  ./ "root@${HOST}:${REMOTE_DIR}/"

echo "==> docker compose up -d --build"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" \
  "cd ${REMOTE_DIR} && docker compose -f ${COMPOSE_FILE} up -d --build"

echo "==> Deployed to https://${HOST}"
