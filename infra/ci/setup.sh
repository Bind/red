#!/usr/bin/env bash
set -euo pipefail

write_ci_env() {
  local sha="$1"
  cat > .env <<EOF
GIT_COMMIT=${sha}
WIDE_EVENTS_HOST=0.0.0.0
WIDE_EVENTS_PORT=4090
WIDE_EVENTS_STORAGE_BACKEND=file
WIDE_EVENTS_DATA_DIR=/data/wide-events
WIDE_EVENTS_RAW_EVENTS_DIR=/data/wide-events/raw
WIDE_EVENTS_ROLLUP_DIR=/data/wide-events/rollup
WIDE_EVENTS_RAW_BUCKET=wide-events-raw
WIDE_EVENTS_RAW_PREFIX=raw
WIDE_EVENTS_ROLLUP_BUCKET=wide-events-rollup
WIDE_EVENTS_ROLLUP_PREFIX=rollup
WIDE_EVENTS_SWEEP_INTERVAL_MS=5000
WIDE_EVENTS_INCOMPLETE_GRACE_MS=60000
WIDE_EVENTS_REPLAY_WINDOW_MS=600000
WIDE_EVENTS_S3_ENDPOINT=http://s3:9000
WIDE_EVENTS_S3_REGION=us-east-1
WIDE_EVENTS_S3_ACCESS_KEY_ID=minioadmin
WIDE_EVENTS_S3_SECRET_ACCESS_KEY=minioadmin
EOF
}

write_codex_auth() {
  local auth_dir auth_path
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
}

if [[ $# -gt 0 ]]; then
  write_ci_env "${1:?usage: $0 [git-sha]}"
fi

if [[ -n "${CODEX_AUTH_JSON_BASE64:-}" || -n "${CODEX_AUTH_JSON:-}" ]]; then
  write_codex_auth
fi
