#!/bin/bash
set -euo pipefail

# Required env vars:
#   REPO_URL      - git clone URL (with credentials if needed)
#   BASE_REF      - base branch to compare against
#   HEAD_SHA      - commit to analyze
#   CODEX_PROMPT  - the prompt to send to codex
#   OPENAI_API_KEY - for codex auth (inherited from env)

WORKDIR="/tmp/repo"

# Clone the repo
git clone --quiet "$REPO_URL" "$WORKDIR" 2>/dev/null
cd "$WORKDIR"

# Fetch and checkout the target commit
git fetch --quiet origin "$HEAD_SHA" 2>/dev/null || true
git checkout --quiet "$HEAD_SHA" 2>/dev/null

# Run codex in read-only sandbox mode with the prompt
# Output goes to stdout, errors to stderr
exec codex exec \
  "$CODEX_PROMPT" \
  --full-auto \
  -s read-only \
  -c 'model_reasoning_effort="medium"' \
  2>/dev/null
