#!/usr/bin/env bash
# Nightly cron: clean preview stacks older than MAX_AGE_DAYS.
# Runs ON the dev box (not from CI). Installed by setup-host.sh.
#
# Usage: ./infra/preview/cleanup.sh [max-age-days]
set -euo pipefail

MAX_AGE_DAYS="${1:-14}"
PREVIEWS_DIR="/opt/redc-previews"
CADDY_SITE_DIR="/opt/redc-preview-caddy/caddy/sites"

[ -d "${PREVIEWS_DIR}" ] || exit 0

teardown_preview_project() {
  local dir="$1"
  local project="$2"

  if [ -f "${dir}/infra/base/compose.yml" ] && [ -f "${dir}/infra/preview/compose.yml" ]; then
    (cd "$dir" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/base/compose.yml -f infra/preview/compose.yml down -v --remove-orphans) || true
    return 0
  fi

  if [ -f "${dir}/infra/compose/runtime.yml" ] && [ -f "${dir}/infra/compose/preview.yml" ]; then
    (cd "$dir" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/compose/runtime.yml -f infra/compose/preview.yml down -v --remove-orphans) || true
    return 0
  fi

  if [ -f "${dir}/infra/compose/preview.yml" ]; then
    (cd "$dir" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/compose/preview.yml down -v --remove-orphans) || true
    return 0
  fi

  ids=$(docker ps -aq --filter label=com.docker.compose.project="${project}")
  if [ -n "${ids}" ]; then
    docker rm -f ${ids} || true
  fi

  vids=$(docker volume ls -q --filter label=com.docker.compose.project="${project}")
  if [ -n "${vids}" ]; then
    docker volume rm -f ${vids} || true
  fi

  nids=$(docker network ls -q --filter label=com.docker.compose.project="${project}")
  if [ -n "${nids}" ]; then
    docker network rm ${nids} || true
  fi
}

find "${PREVIEWS_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime "+${MAX_AGE_DAYS}" -print0 \
  | while IFS= read -r -d '' dir; do
    slug="$(basename "$dir")"
    project="preview-${slug}"
    echo "==> Evicting preview ${slug} (older than ${MAX_AGE_DAYS} days)"
    teardown_preview_project "${dir}" "${project}"
    rm -rf "$dir"
    rm -f "${CADDY_SITE_DIR}/${slug}.caddy"
  done

if docker ps --format '{{.Names}}' | grep -qx preview-caddy; then
  docker exec preview-caddy caddy reload --config /etc/caddy/preview.Caddyfile || true
fi

docker system prune -af --volumes || true
docker builder prune -af || true
