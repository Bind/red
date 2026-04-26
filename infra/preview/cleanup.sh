#!/usr/bin/env bash
# Nightly cron: clean preview stacks older than MAX_AGE_DAYS.
# Runs ON the dev box (not from CI). Installed by setup-host.sh.
#
# Usage: ./infra/preview/cleanup.sh [max-age-days]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../platform/utils.sh"

MAX_AGE_DAYS="${1:-14}"
PREVIEWS_DIR="/opt/red-previews"
CADDY_SITE_DIR="/opt/red-preview-caddy/caddy/sites"

[ -d "${PREVIEWS_DIR}" ] || exit 0

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
