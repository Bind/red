#!/usr/bin/env bash
# One-time setup on a freshly-provisioned prod box (Hetzner cax11+, Ubuntu 24.04).
# Idempotent: re-running is safe.
#
# Prerequisites: root SSH access.
#
# Usage (run on the prod box):
#   sudo bash setup-host.sh
# Optional env:
#   DOTENV_PRIVATE_KEY_PRODUCTION=...   write prod dotenvx key into /root/.bashrc
#   BOOTSTRAP_PROD_ENV=1                decrypt /opt/red/.env.production → /opt/red/.env
set -euo pipefail

PROD_DIR="/opt/red"
SSH_PORT="2222"

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

echo "==> Ensuring ${PROD_DIR} exists"
mkdir -p "${PROD_DIR}"
chmod 755 "${PROD_DIR}"

echo "==> Moving sshd to port ${SSH_PORT}"
sed -i "s/^#\\?Port .*/Port ${SSH_PORT}/" /etc/ssh/sshd_config
systemctl restart ssh

if [[ -n "${DOTENV_PRIVATE_KEY_PRODUCTION:-}" ]]; then
  echo "==> Persisting DOTENV_PRIVATE_KEY_PRODUCTION into /root/.bashrc"
  touch /root/.bashrc
  grep -v '^export DOTENV_PRIVATE_KEY_PRODUCTION=' /root/.bashrc > /root/.bashrc.tmp || true
  mv /root/.bashrc.tmp /root/.bashrc
  printf "export DOTENV_PRIVATE_KEY_PRODUCTION=%q\n" "${DOTENV_PRIVATE_KEY_PRODUCTION}" >> /root/.bashrc
fi

if [[ "${BOOTSTRAP_PROD_ENV:-0}" == "1" ]]; then
  if [[ -z "${DOTENV_PRIVATE_KEY_PRODUCTION:-}" ]]; then
    echo "error: BOOTSTRAP_PROD_ENV=1 requires DOTENV_PRIVATE_KEY_PRODUCTION" >&2
    exit 1
  fi
  if [[ ! -f "${PROD_DIR}/.env.production" ]]; then
    echo "error: ${PROD_DIR}/.env.production is missing" >&2
    exit 1
  fi
  echo "==> Decrypting ${PROD_DIR}/.env.production → ${PROD_DIR}/.env"
  (
    cd "${PROD_DIR}"
    dotenvx decrypt -f .env.production -o .env
    chmod 600 .env
  )
fi

echo "==> Prod box setup complete."
echo ""
echo "    Next steps:"
echo ""
echo "    1. Verify ssh is now available on port ${SSH_PORT} with the prod deploy key."
echo "    2. Verify /opt/red/.env exists if you passed BOOTSTRAP_PROD_ENV=1."
echo "    3. Run the normal deploy path:"
echo "         just deploy-ssh <release-tag> <commit-sha> ${HOSTNAME:-host} ${SSH_PORT}"
