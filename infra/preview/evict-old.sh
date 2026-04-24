#!/usr/bin/env bash
# Nightly cron: evict preview stacks older than MAX_AGE_DAYS.
# Runs ON the dev box (not from CI). Installed by setup-box.sh.
#
# Usage: ./infra/preview/evict-old.sh [max-age-days]
set -euo pipefail

MAX_AGE_DAYS="${1:-14}"
PREVIEWS_DIR="/opt/redc-previews"
CADDY_SITE_DIR="/opt/redc-preview-caddy/caddy/sites"

[ -d "${PREVIEWS_DIR}" ] || exit 0

find "${PREVIEWS_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime "+${MAX_AGE_DAYS}" -print0 \
  | while IFS= read -r -d '' dir; do
    slug="$(basename "$dir")"
    project="preview-${slug}"
    echo "==> Evicting preview ${slug} (older than ${MAX_AGE_DAYS} days)"
    if [ -f "${dir}/infra/preview/compose.yml" ]; then
      (cd "$dir" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/base/compose.yml -f infra/preview/compose.yml down -v --remove-orphans) || true
    else
      docker compose -p "${project}" down -v --remove-orphans 2>/dev/null || true
    fi
    rm -rf "$dir"
    rm -f "${CADDY_SITE_DIR}/${slug}.caddy"
  done

if docker ps --format '{{.Names}}' | grep -qx preview-caddy; then
  docker exec preview-caddy caddy reload --config /etc/caddy/preview.Caddyfile || true
fi

docker system prune -af --volumes || true
docker builder prune -af || true
