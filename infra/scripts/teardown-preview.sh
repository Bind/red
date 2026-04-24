#!/usr/bin/env bash
# Tears down a per-PR preview stack and removes its working dir.
#
# Usage: ./infra/scripts/teardown-preview.sh <slug> <host> [ssh-port]
set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <host> [ssh-port]}"
HOST="${2:?Usage: $0 <slug> <host> [ssh-port]}"
SSH_PORT="${3:-2222}"
REMOTE_DIR="/opt/redc-previews/${SLUG}"
PROJECT="preview-${SLUG}"
CADDY_SITE_FILE="/opt/redc-preview-caddy/caddy/sites/${SLUG}.caddy"

echo "==> Tearing down preview ${SLUG} on ${HOST}"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" "bash -s" <<REMOTE
set -euo pipefail
if [ -d "${REMOTE_DIR}" ]; then
  cd "${REMOTE_DIR}"
  COMPOSE_PROJECT_NAME=${PROJECT} docker compose -f infra/compose/runtime.yml -f infra/compose/preview.yml down -v --remove-orphans || true
  cd /
  rm -rf "${REMOTE_DIR}"
  echo "==> Removed ${REMOTE_DIR}"
else
  echo "==> ${REMOTE_DIR} does not exist; nothing to do"
fi

rm -f "${CADDY_SITE_FILE}"
if docker ps --format '{{.Names}}' | grep -qx preview-caddy; then
  docker exec preview-caddy caddy reload --config /etc/caddy/preview.Caddyfile || true
fi
REMOTE

echo "==> Preview ${SLUG} torn down"
