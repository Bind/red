#!/usr/bin/env bash
# One-time setup on a freshly-provisioned dev box (Hetzner cax11+, Ubuntu 24.04).
# Idempotent: re-running is safe.
#
# Prerequisites: root SSH access, docker installed. (User-data in sst.config.ts
# installs docker for the prod box; for the manually-provisioned dev box,
# install it yourself or run this script's docker-install branch.)
#
# Usage (run on the dev box): curl/scp this script over, then:
#   sudo bash setup-dev-box.sh
set -euo pipefail

PREVIEWS_DIR="/opt/redc-previews"
PREVIEW_NET="preview-net"
CRON_FILE="/etc/cron.d/redc-preview-evict"
EVICT_SCRIPT="${PREVIEWS_DIR}/evict-old-previews.sh"
CADDY_DIR="/opt/redc-preview-caddy"

echo "==> Installing docker (if missing)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
fi

echo "==> mkdir ${PREVIEWS_DIR}"
mkdir -p "${PREVIEWS_DIR}"

echo "==> Creating docker network ${PREVIEW_NET}"
if ! docker network inspect "${PREVIEW_NET}" >/dev/null 2>&1; then
  docker network create "${PREVIEW_NET}"
fi

echo "==> Installing evict script at ${EVICT_SCRIPT}"
cat > "${EVICT_SCRIPT}" <<'EVICT'
#!/usr/bin/env bash
set -euo pipefail
MAX_AGE_DAYS="${1:-14}"
PREVIEWS_DIR="/opt/redc-previews"
[ -d "${PREVIEWS_DIR}" ] || exit 0
find "${PREVIEWS_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime "+${MAX_AGE_DAYS}" -print0 \
  | while IFS= read -r -d '' dir; do
    slug="$(basename "$dir")"
    project="preview-${slug}"
    echo "Evicting ${slug}"
    if [ -f "${dir}/infra/compose/preview.yml" ]; then
      (cd "$dir" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/compose/preview.yml down -v --remove-orphans) || true
    else
      docker compose -p "${project}" down -v --remove-orphans 2>/dev/null || true
    fi
    rm -rf "$dir"
  done
EVICT
chmod +x "${EVICT_SCRIPT}"

echo "==> Installing nightly cron at ${CRON_FILE}"
cat > "${CRON_FILE}" <<CRON
# m h dom mon dow user command
17 3 * * * root ${EVICT_SCRIPT} 14 >> /var/log/redc-preview-evict.log 2>&1
CRON
chmod 644 "${CRON_FILE}"

echo "==> Dev box setup complete."
echo "    Next: bring up the permanent preview Caddy."
echo "    Sync infra/caddy/preview.Caddyfile + infra/compose/preview-caddy.yml to the box"
echo "    (or clone the repo), then:"
echo "      cd /opt/redc && docker compose -f infra/compose/preview-caddy.yml up -d"
echo ""
echo "    Preview URLs will resolve to this box via the wildcard DNS managed"
echo "    by \`sst deploy --stage dev\`."
