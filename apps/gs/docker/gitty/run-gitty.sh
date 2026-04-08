#!/usr/bin/env bash
set -euo pipefail

PORT="${GIT_SERVER_PORT:-8080}"
DATA_DIR="${GIT_SERVER_NATIVE_DATA_DIR:-/tmp/libgitty-data}"

echo "starting native zig git server on :${PORT}"
exec /usr/local/bin/gitty-server "${PORT}" "${DATA_DIR}"
