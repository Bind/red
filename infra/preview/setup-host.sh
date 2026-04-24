#!/usr/bin/env bash
# One-time setup on a freshly-provisioned dev box (Hetzner cax11+, Ubuntu 24.04).
# Idempotent: re-running is safe.
#
# Prerequisites: root SSH access.
#
# Usage (run on the dev box):
#   sudo bash setup-host.sh
# Optional env:
#   DOTENV_PRIVATE_KEY_PREVIEW=...   write preview dotenvx key into /root/.bashrc
#   BOOTSTRAP_PREVIEW_ENV=1          decrypt /opt/redc-previews/.env.preview → /opt/redc-previews/.env
set -euo pipefail

PREVIEWS_DIR="/opt/redc-previews"
PREVIEW_NET="preview-net"
CRON_FILE="/etc/cron.d/redc-preview-cleanup"
EVICT_SCRIPT="${PREVIEWS_DIR}/preview-cleanup.sh"
CADDY_DIR="/opt/redc-preview-caddy"
CADDY_COMPOSE="${CADDY_DIR}/compose.yml"
CADDY_CONFIG_DIR="${CADDY_DIR}/caddy"
CADDYFILE="${CADDY_CONFIG_DIR}/preview.Caddyfile"
CADDY_SITES_DIR="${CADDY_CONFIG_DIR}/sites"

wait_for_apt() {
  local attempts="${1:-60}"
  local sleep_seconds="${2:-5}"
  for ((i=0; i<attempts; i++)); do
    if ! fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
      && ! fuser /var/lib/apt/lists/lock >/dev/null 2>&1 \
      && ! fuser /var/cache/apt/archives/lock >/dev/null 2>&1; then
      return 0
    fi
    sleep "${sleep_seconds}"
  done
  echo "error: timed out waiting for apt/dpkg lock" >&2
  return 1
}

echo "==> Installing docker (if missing)"
if ! command -v docker >/dev/null 2>&1; then
  wait_for_apt
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
fi

echo "==> Installing dotenvx (if missing)"
if ! command -v dotenvx >/dev/null 2>&1; then
  wait_for_apt
  curl -fsS https://dotenvx.sh | sh
fi

echo "==> mkdir ${PREVIEWS_DIR}"
mkdir -p "${PREVIEWS_DIR}"
chmod 755 "${PREVIEWS_DIR}"

echo "==> mkdir ${CADDY_DIR}"
mkdir -p "${CADDY_SITES_DIR}"

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
    echo "Evicting ${slug}"
    teardown_preview_project "${dir}" "${project}"
    rm -rf "$dir"
    rm -f "${CADDY_SITE_DIR}/${slug}.caddy"
  done

if docker ps --format '{{.Names}}' | grep -qx preview-caddy; then
  docker exec preview-caddy caddy reload --config /etc/caddy/preview.Caddyfile || true
fi

docker system prune -af --volumes || true
docker builder prune -af || true
EVICT
chmod +x "${EVICT_SCRIPT}"

echo "==> Installing nightly cron at ${CRON_FILE}"
cat > "${CRON_FILE}" <<CRON
# m h dom mon dow user command
17 3 * * * root ${EVICT_SCRIPT} 14 >> /var/log/redc-preview-cleanup.log 2>&1
CRON
chmod 644 "${CRON_FILE}"

echo "==> Writing preview Caddy compose at ${CADDY_COMPOSE}"
cat > "${CADDY_COMPOSE}" <<'COMPOSE'
services:
  caddy:
    container_name: preview-caddy
    image: caddy:2-alpine
    command: ["caddy", "run", "--config", "/etc/caddy/preview.Caddyfile", "--adapter", "caddyfile"]
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./caddy:/etc/caddy:ro
      - preview-caddy-data:/data
      - preview-caddy-config:/config
    networks:
      - preview-net

networks:
  preview-net:
    external: true

volumes:
  preview-caddy-data:
  preview-caddy-config:
COMPOSE

echo "==> Writing preview Caddyfile at ${CADDYFILE}"
cat > "${CADDYFILE}" <<'CADDY'
import /etc/caddy/sites/*.caddy
CADDY

if [[ -n "${DOTENV_PRIVATE_KEY_PREVIEW:-}" ]]; then
  echo "==> Persisting DOTENV_PRIVATE_KEY_PREVIEW into /root/.bashrc"
  touch /root/.bashrc
  grep -v '^export DOTENV_PRIVATE_KEY_PREVIEW=' /root/.bashrc > /root/.bashrc.tmp || true
  mv /root/.bashrc.tmp /root/.bashrc
  printf "export DOTENV_PRIVATE_KEY_PREVIEW=%q\n" "${DOTENV_PRIVATE_KEY_PREVIEW}" >> /root/.bashrc
fi

if [[ "${BOOTSTRAP_PREVIEW_ENV:-0}" == "1" ]]; then
  if [[ -z "${DOTENV_PRIVATE_KEY_PREVIEW:-}" ]]; then
    echo "error: BOOTSTRAP_PREVIEW_ENV=1 requires DOTENV_PRIVATE_KEY_PREVIEW" >&2
    exit 1
  fi
  if [[ ! -f "${PREVIEWS_DIR}/.env.preview" ]]; then
    echo "error: ${PREVIEWS_DIR}/.env.preview is missing" >&2
    exit 1
  fi
  echo "==> Decrypting ${PREVIEWS_DIR}/.env.preview → ${PREVIEWS_DIR}/.env"
  (
    cd "${PREVIEWS_DIR}"
    dotenvx decrypt -f .env.preview --stdout > .env
    chmod 600 .env
  )
fi

echo "==> Starting preview Caddy"
(cd "${CADDY_DIR}" && docker compose -f "${CADDY_COMPOSE}" up -d)

echo "==> Dev box setup complete."
echo ""
echo "    Next steps:"
echo ""
echo "    1. If you did not pass DOTENV_PRIVATE_KEY_PREVIEW to this script,"
echo "       export it so deploys can decrypt the per-PR secret env:"
echo "         echo 'export DOTENV_PRIVATE_KEY_PREVIEW=<key>' >> /root/.bashrc"
echo ""
echo "    2. Create /opt/redc-previews/.env with preview secrets or let"
echo "       infra/preview/deploy.sh decrypt .env.preview into place."
echo ""
echo "    Preview URLs will resolve to this box via the wildcard DNS managed"
echo "    by \`sst deploy --stage dev\`."
