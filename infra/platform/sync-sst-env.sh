#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUTS_FILE="${ROOT_DIR}/.sst/outputs.json"

if [[ ! -f "${OUTPUTS_FILE}" ]]; then
  echo "error: missing ${OUTPUTS_FILE}; run 'just provision <stage>' first" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

if ! command -v dotenvx >/dev/null 2>&1; then
  echo "error: dotenvx is required" >&2
  exit 1
fi

repo_from_origin() {
  local origin
  origin="$(git -C "${ROOT_DIR}" config --get remote.origin.url || true)"
  if [[ -z "${origin}" ]]; then
    echo "error: unable to infer repo id from git remote.origin.url" >&2
    exit 1
  fi

  origin="${origin%.git}"
  origin="${origin#git@github.com:}"
  origin="${origin#ssh://git@github.com/}"
  origin="${origin#https://github.com/}"
  origin="${origin#http://github.com/}"

  if [[ "${origin}" != */* ]]; then
    echo "error: unsupported remote.origin.url '${origin}'" >&2
    exit 1
  fi

  printf '%s\n' "${origin}"
}

daemon_memory_bucket="$(jq -er '.daemonMemoryBucket' "${OUTPUTS_FILE}")"
daemon_memory_endpoint="$(jq -er '.daemonMemoryEndpoint' "${OUTPUTS_FILE}")"
daemon_memory_access_key_id="$(jq -er '.daemonMemoryAccessKeyId' "${OUTPUTS_FILE}")"
daemon_memory_secret_access_key="$(jq -er '.daemonMemorySecretAccessKey' "${OUTPUTS_FILE}")"
daemon_memory_repo="$(repo_from_origin)"
server_ip="$(jq -er '.serverIp' "${OUTPUTS_FILE}")"
dns_record="$(jq -er '.dnsRecord' "${OUTPUTS_FILE}")"

if [[ "$#" -eq 0 ]]; then
  set -- "${ROOT_DIR}/.env" "${ROOT_DIR}/.env.ci"
fi

for target in "$@"; do
  case "${target}" in
    /*) env_file="${target}" ;;
    *) env_file="${ROOT_DIR}/${target}" ;;
  esac

  dotenvx set AI_DAEMONS_MEMORY_BACKEND r2 -f "${env_file}"
  dotenvx set AI_DAEMONS_MEMORY_REPO "${daemon_memory_repo}" -f "${env_file}"
  dotenvx set AI_DAEMONS_R2_BUCKET "${daemon_memory_bucket}" -f "${env_file}"
  dotenvx set AI_DAEMONS_R2_ENDPOINT "${daemon_memory_endpoint}" -f "${env_file}"
  dotenvx set AI_DAEMONS_R2_ACCESS_KEY_ID "${daemon_memory_access_key_id}" -f "${env_file}"
  dotenvx set AI_DAEMONS_R2_SECRET_ACCESS_KEY "${daemon_memory_secret_access_key}" -f "${env_file}"
  dotenvx set REDC_SERVER_IP "${server_ip}" -f "${env_file}"
  dotenvx set REDC_DNS_RECORD "${dns_record}" -f "${env_file}"
done
