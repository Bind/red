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

echo "==> Tearing down preview ${SLUG} on ${HOST}"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" "bash -s" <<REMOTE
set -euo pipefail

teardown_preview_project() {
  local dir="\$1"
  local project="\$2"

  if [ -f "\${dir}/infra/base/compose.yml" ] && [ -f "\${dir}/infra/preview/compose.yml" ]; then
    (cd "\${dir}" && COMPOSE_PROJECT_NAME="\${project}" docker compose -f infra/base/compose.yml -f infra/preview/compose.yml down -v --remove-orphans) || true
    return 0
  fi

  if [ -f "\${dir}/infra/compose/runtime.yml" ] && [ -f "\${dir}/infra/compose/preview.yml" ]; then
    (cd "\${dir}" && COMPOSE_PROJECT_NAME="\${project}" docker compose -f infra/compose/runtime.yml -f infra/compose/preview.yml down -v --remove-orphans) || true
    return 0
  fi

  if [ -f "\${dir}/infra/compose/preview.yml" ]; then
    (cd "\${dir}" && COMPOSE_PROJECT_NAME="\${project}" docker compose -f infra/compose/preview.yml down -v --remove-orphans) || true
    return 0
  fi

  ids=\$(docker ps -aq --filter label=com.docker.compose.project="\${project}")
  if [ -n "\${ids}" ]; then
    docker rm -f \${ids} || true
  fi

  vids=\$(docker volume ls -q --filter label=com.docker.compose.project="\${project}")
  if [ -n "\${vids}" ]; then
    docker volume rm -f \${vids} || true
  fi

  nids=\$(docker network ls -q --filter label=com.docker.compose.project="\${project}")
  if [ -n "\${nids}" ]; then
    docker network rm \${nids} || true
  fi
}

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
