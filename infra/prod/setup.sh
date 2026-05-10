#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?usage: setup.sh <host-or-ip>}"
PORT="${2:-22}"
REMOTE_SCRIPT="/root/setup-prod-box.sh"
REMOTE_PROD_ENV="/root/.env.production"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMP_KEY="$(mktemp)"
SSH_OPTS=(
  -o StrictHostKeyChecking=accept-new
  -o UserKnownHostsFile="${HOME}/.ssh/known_hosts"
)

cleanup() {
  rm -f "${TMP_KEY}"
}
trap cleanup EXIT

if ! command -v dotenvx >/dev/null 2>&1; then
  echo "error: dotenvx is required locally" >&2
  exit 1
fi

cd "${REPO_ROOT}"

mkdir -p "${HOME}/.ssh"
ssh-keygen -R "[${HOST}]:${PORT}" >/dev/null 2>&1 || true
ssh-keygen -R "${HOST}" >/dev/null 2>&1 || true

PROD_SSH_PRIVATE_KEY_VALUE="$(dotenvx get HETZNER_SSH_PRIVATE_KEY -f .env.ci --format shell)"
if printf "%s" "${PROD_SSH_PRIVATE_KEY_VALUE}" | grep -q "^-----BEGIN "; then
  printf "%s\n" "${PROD_SSH_PRIVATE_KEY_VALUE}" > "${TMP_KEY}"
else
  printf "%s" "${PROD_SSH_PRIVATE_KEY_VALUE}" | openssl base64 -d -A > "${TMP_KEY}"
fi
chmod 600 "${TMP_KEY}"

PROD_KEY=""
if [[ -f .env.keys ]]; then
  PROD_KEY="$(awk -F= '$1=="DOTENV_PRIVATE_KEY_PRODUCTION"{print substr($0, index($0,$2))}' .env.keys | tail -n1)"
fi

scp "${SSH_OPTS[@]}" -P "${PORT}" -i "${TMP_KEY}" "${SCRIPT_DIR}/setup-host.sh" "root@${HOST}:${REMOTE_SCRIPT}"

if [[ -n "${PROD_KEY}" ]]; then
  scp "${SSH_OPTS[@]}" -P "${PORT}" -i "${TMP_KEY}" "${REPO_ROOT}/.env.production" "root@${HOST}:${REMOTE_PROD_ENV}"
  ssh "${SSH_OPTS[@]}" -p "${PORT}" -i "${TMP_KEY}" "root@${HOST}" \
    "DOTENV_PRIVATE_KEY_PRODUCTION='${PROD_KEY}' BOOTSTRAP_PROD_ENV=1 bash ${REMOTE_SCRIPT}"
else
  ssh "${SSH_OPTS[@]}" -p "${PORT}" -i "${TMP_KEY}" "root@${HOST}" "bash ${REMOTE_SCRIPT}"
fi
