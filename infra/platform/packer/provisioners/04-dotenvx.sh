#!/usr/bin/env bash
set -euo pipefail

echo "==> installing dotenvx"
curl -fsS https://dotenvx.sh | sh

# Sanity check — fail the build if the binary isn't on PATH.
command -v dotenvx >/dev/null
dotenvx --version
