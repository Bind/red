#!/usr/bin/env bash
set -euo pipefail

KEY="${1:?usage: get-required-dotenvx-value.sh <key> <env-file>}"
ENV_FILE="${2:?usage: get-required-dotenvx-value.sh <key> <env-file>}"

if ! command -v dotenvx >/dev/null 2>&1; then
  echo "error: dotenvx is required" >&2
  exit 1
fi

value="$(dotenvx get "${KEY}" -f "${ENV_FILE}" 2>/dev/null || true)"

if [[ -z "${value}" || "${value}" == *"[MISSING_KEY]"* ]]; then
  echo "error: required key ${KEY} is missing from ${ENV_FILE}" >&2
  exit 1
fi

printf '%s\n' "${value}"
