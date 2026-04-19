#!/usr/bin/env bash
# Nightly cron: evict preview stacks older than MAX_AGE_DAYS.
# Runs ON the dev box (not from CI). Installed by setup-dev-box.sh.
#
# Usage: ./infra/scripts/evict-old-previews.sh [max-age-days]
set -euo pipefail

MAX_AGE_DAYS="${1:-14}"
PREVIEWS_DIR="/opt/redc-previews"

[ -d "${PREVIEWS_DIR}" ] || exit 0

find "${PREVIEWS_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime "+${MAX_AGE_DAYS}" -print0 \
  | while IFS= read -r -d '' dir; do
    slug="$(basename "$dir")"
    project="preview-${slug}"
    echo "==> Evicting preview ${slug} (older than ${MAX_AGE_DAYS} days)"
    if [ -f "${dir}/infra/compose/preview.yml" ]; then
      (cd "$dir" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/compose/preview.yml down -v --remove-orphans) || true
    else
      docker compose -p "${project}" down -v --remove-orphans 2>/dev/null || true
    fi
    rm -rf "$dir"
  done
