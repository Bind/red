#!/usr/bin/env bash
set -euo pipefail

echo "==> installing bun"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

echo "==> installing just"
if ! command -v just >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
    | bash -s -- --to "$HOME/.local/bin"
fi

echo "==> installing claude code CLI"
if ! command -v claude >/dev/null 2>&1; then
  bun install -g @anthropic-ai/claude-code
fi

echo "==> warming workspace deps"
bun install || echo "bun install failed; re-run manually if needed"

cat <<'EOF'

==> setup complete

Next steps:
  1. echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
  2. echo "SMITHERS_API_KEY=$(openssl rand -hex 32)" >> .env
  3. claude       # start a Claude Code session in this repo
  4. just up      # once the session is driving, bring up the base stack
  5. just triage-up && just triage-smithers-mode
EOF
