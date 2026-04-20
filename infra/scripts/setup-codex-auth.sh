#!/usr/bin/env bash
set -euo pipefail

auth_dir="${HOME}/.codex"
auth_path="${auth_dir}/auth.json"

mkdir -p "${auth_dir}"

if [[ -n "${CODEX_AUTH_JSON_BASE64:-}" ]]; then
	printf '%s' "${CODEX_AUTH_JSON_BASE64}" | base64 --decode > "${auth_path}"
elif [[ -n "${CODEX_AUTH_JSON:-}" ]]; then
	printf '%s' "${CODEX_AUTH_JSON}" > "${auth_path}"
else
	echo "CODEX_AUTH_JSON_BASE64 or CODEX_AUTH_JSON is required" >&2
	exit 1
fi

chmod 600 "${auth_path}"
echo "Configured Codex auth at ${auth_path}"
