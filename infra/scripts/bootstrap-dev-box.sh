#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?usage: bootstrap-dev-box.sh <host-or-ip>}"
PORT="${2:-2222}"
REMOTE_SCRIPT="/root/setup-dev-box.sh"
REMOTE_PREVIEW_ENV="/opt/redc-previews/.env.preview"
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

DEV_SSH_PRIVATE_KEY_VALUE="$(dotenvx get DEV_SSH_PRIVATE_KEY -f .env.ci --format shell)"
if printf "%s" "${DEV_SSH_PRIVATE_KEY_VALUE}" | grep -q "^-----BEGIN "; then
  printf "%s\n" "${DEV_SSH_PRIVATE_KEY_VALUE}" > "${TMP_KEY}"
else
  printf "%s" "${DEV_SSH_PRIVATE_KEY_VALUE}" | openssl base64 -d -A > "${TMP_KEY}"
fi
chmod 600 "${TMP_KEY}"

PREVIEW_KEY=""
if [[ -f .env.keys ]]; then
  PREVIEW_KEY="$(awk -F= '$1=="DOTENV_PRIVATE_KEY_PREVIEW"{print substr($0, index($0,$2))}' .env.keys | tail -n1)"
fi

scp "${SSH_OPTS[@]}" -P "${PORT}" -i "${TMP_KEY}" "${SCRIPT_DIR}/setup-dev-box.sh" "root@${HOST}:${REMOTE_SCRIPT}"

if [[ -n "${PREVIEW_KEY}" ]]; then
  scp "${SSH_OPTS[@]}" -P "${PORT}" -i "${TMP_KEY}" "${REPO_ROOT}/.env.preview" "root@${HOST}:${REMOTE_PREVIEW_ENV}"
  ssh "${SSH_OPTS[@]}" -p "${PORT}" -i "${TMP_KEY}" "root@${HOST}" \
    "DOTENV_PRIVATE_KEY_PREVIEW='${PREVIEW_KEY}' BOOTSTRAP_PREVIEW_ENV=1 bash ${REMOTE_SCRIPT}"
else
  ssh "${SSH_OPTS[@]}" -p "${PORT}" -i "${TMP_KEY}" "root@${HOST}" "bash ${REMOTE_SCRIPT}"
fi
