#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit

echo "Configured git hooks at .githooks"
