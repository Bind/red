#!/usr/bin/env bash
set -euo pipefail

# Deploys the current working tree to the Hetzner host via rsync + ssh.
# The encrypted .env.production is rsynced and decrypted in place on the box
# using DOTENV_PRIVATE_KEY_PRODUCTION (exported in the box's shell profile).
#
# Usage: ./infra/scripts/deploy.sh <host> [ssh-port]

HOST="${1:?Usage: $0 <host> [ssh-port]}"
SSH_PORT="${2:-2222}"
REMOTE_DIR="/opt/redc"
COMPOSE_FILE="infra/compose/prod.yml"

echo "==> Syncing files to ${HOST} (port ${SSH_PORT})"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .sst \
  --exclude .env \
  --exclude .env.keys \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  -e "ssh -p ${SSH_PORT} -o StrictHostKeyChecking=accept-new" \
  ./ "root@${HOST}:${REMOTE_DIR}/"

echo "==> Decrypting .env.production and bringing up compose"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" "bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/redc

if [ -z "${DOTENV_PRIVATE_KEY_PRODUCTION:-}" ]; then
  echo "error: DOTENV_PRIVATE_KEY_PRODUCTION is not set on the host." >&2
  echo "       export it in /root/.bashrc or a systemd env file." >&2
  exit 1
fi

if ! command -v dotenvx >/dev/null 2>&1; then
  echo "==> Installing dotenvx"
  curl -fsS https://dotenvx.sh | sh
fi

dotenvx decrypt -f .env.production -o .env
chmod 600 .env

docker compose -f infra/compose/prod.yml up -d --build
REMOTE

echo "==> Deployed to https://${HOST}"
