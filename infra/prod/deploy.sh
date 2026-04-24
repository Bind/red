#!/usr/bin/env bash
set -euo pipefail

# Deploys the current working tree to the Hetzner host via rsync + ssh.
# The encrypted .env.production is rsynced and decrypted in place on the box
# using DOTENV_PRIVATE_KEY_PRODUCTION (exported in the box's shell profile).
# Compose then pulls immutable GHCR tags rather than building locally.
#
# Usage: ./infra/prod/deploy.sh <host> [ssh-port] <image-tag> <git-commit>

HOST="${1:?Usage: $0 <host> [ssh-port]}"
SSH_PORT="${2:-2222}"
IMAGE_TAG="${3:?Usage: $0 <host> [ssh-port] <image-tag> <git-commit>}"
GIT_COMMIT="${4:?Usage: $0 <host> [ssh-port] <image-tag> <git-commit>}"
REMOTE_DIR="/opt/redc"

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

echo "==> Decrypting .env.production and pulling compose images"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" \
  IMAGE_TAG="${IMAGE_TAG}" GIT_COMMIT="${GIT_COMMIT}" "bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/redc

if [ -z "${DOTENV_PRIVATE_KEY_PRODUCTION:-}" ] && [ -f /root/.bashrc ]; then
  # Load just the persisted production dotenvx key without evaluating interactive shell setup.
  production_key_line=$(grep -E '^export DOTENV_PRIVATE_KEY_PRODUCTION=' /root/.bashrc | tail -n1 || true)
  if [ -n "${production_key_line}" ]; then
    export "${production_key_line#export }"
  fi
fi

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

set -a
. ./.env
set +a

if [ -n "${GHCR_USERNAME:-}" ] && [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin
fi

export IMAGE_TAG GIT_COMMIT
docker compose -f infra/base/compose.yml -f infra/prod/compose.yml pull
docker compose -f infra/base/compose.yml -f infra/prod/compose.yml up -d
REMOTE

echo "==> Deployed to https://${HOST}"
