#!/bin/bash
set -euo pipefail

# Required env vars:
#   REPO_URL       - git clone URL (with credentials if needed)
#   BASE_REF       - base branch to compare against
#   HEAD_REF       - branch or SHA to checkout
#   TASK_PROMPT    - the prompt to send to codex
#   OPENAI_API_KEY - for codex auth (inherited from env)

WORKDIR="/tmp/repo"

# Clone the repo (stderr flows to Docker's stderr for live streaming)
echo "Cloning $REPO_URL..." >&2
git clone --quiet "$REPO_URL" "$WORKDIR"
cd "$WORKDIR"

# Fetch and checkout the target ref
echo "Checking out $HEAD_REF..." >&2
git fetch --quiet origin "$HEAD_REF" || true
git checkout --quiet "$HEAD_REF"

# Ensure base ref is available for git diff origin/$BASE_REF...HEAD
git fetch --quiet origin "$BASE_REF" || true
echo "Running Codex..." >&2

# Codex runs read-only. Capture its stdout to the output bind-mount.
# stderr flows to Docker's stderr so the host can stream it in real time.
exec codex exec \
  "$TASK_PROMPT" \
  --full-auto \
  -s read-only \
  -c 'model_reasoning_effort="medium"' \
  > /output/result.json
