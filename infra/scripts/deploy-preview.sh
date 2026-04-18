#!/usr/bin/env bash
# Deploys the working tree to a per-PR preview stack on the dev box.
#
# Usage: ./infra/scripts/deploy-preview.sh <slug> <host> [ssh-port]
#   slug      PR slug, e.g. pr-42. Used for the compose project name and
#             resulting URL https://<slug>.preview.red.computer.
#   host      dev box hostname/IP
#   ssh-port  default 2222
set -euo pipefail

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
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  -e "ssh -p ${SSH_PORT} -o StrictHostKeyChecking=accept-new" \
  ./ "root@${HOST}:${REMOTE_DIR}/"

echo "==> docker compose up --build (project=${PROJECT})"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" \
  "cd ${REMOTE_DIR} && COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/compose/preview.yml up -d --build"

echo "==> Deployed preview ${SLUG} → https://${SLUG}.preview.red.computer"
