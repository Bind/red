#!/usr/bin/env bash
# Tears down a per-PR preview stack and removes its working dir.
#
# Usage: ./infra/preview/teardown.sh <slug> <host> [ssh-port]
set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <host> [ssh-port]}"
HOST="${2:?Usage: $0 <slug> <host> [ssh-port]}"
SSH_PORT="${3:-2222}"
REMOTE_DIR="/opt/redc-previews/${SLUG}"
PROJECT="preview-${SLUG}"
CADDY_SITE_FILE="/opt/redc-preview-caddy/caddy/sites/${SLUG}.caddy"
PREVIEW_UTILS_CONTENT="$(cat "$(dirname "$0")/../platform/utils.sh")"

echo "==> Tearing down preview ${SLUG} on ${HOST}"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" "bash -s" <<REMOTE
set -euo pipefail

${PREVIEW_UTILS_CONTENT}

if [ -d "${REMOTE_DIR}" ]; then
  teardown_preview_project "${REMOTE_DIR}" "${PROJECT}"
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
