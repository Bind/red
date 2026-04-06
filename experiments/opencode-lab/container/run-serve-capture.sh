#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run-serve-capture.sh --repo-path <path> [--prompt <text> | --prompt-file <path>] --out-file <path> [--messages-file <path>] [--response-file <path>] [--schema-file <path>] [--model <provider/model>] [--system <text>] [--timeout-ms <ms>] [--image <name>] [--auth-file <path>] [--port <n>]
EOF
}

REPO_PATH=""
PROMPT=""
PROMPT_FILE=""
OUT_FILE=""
MESSAGES_FILE=""
RESPONSE_FILE=""
SCHEMA_FILE=""
MODEL="openai/gpt-5.4"
SYSTEM_PROMPT=""
TIMEOUT_MS=""
IMAGE="redc-opencode-lab"
AUTH_FILE="${HOME}/.local/share/opencode/auth.json"
PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-path) REPO_PATH="${2:-}"; shift 2 ;;
    --prompt) PROMPT="${2:-}"; shift 2 ;;
    --prompt-file) PROMPT_FILE="${2:-}"; shift 2 ;;
    --out-file) OUT_FILE="${2:-}"; shift 2 ;;
    --messages-file) MESSAGES_FILE="${2:-}"; shift 2 ;;
    --response-file) RESPONSE_FILE="${2:-}"; shift 2 ;;
    --schema-file) SCHEMA_FILE="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --system) SYSTEM_PROMPT="${2:-}"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --auth-file) AUTH_FILE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$REPO_PATH" || -z "$OUT_FILE" ]]; then
  echo "Missing required flags" >&2
  usage >&2
  exit 1
fi

if [[ -z "$PROMPT" && -z "$PROMPT_FILE" ]]; then
  echo "Missing --prompt or --prompt-file" >&2
  usage >&2
  exit 1
fi

if [[ ! -d "$REPO_PATH" ]]; then
  echo "Repo path does not exist: $REPO_PATH" >&2
  exit 1
fi

if [[ ! -f "$AUTH_FILE" ]]; then
  echo "OpenCode auth file not found: $AUTH_FILE" >&2
  exit 1
fi

if [[ -n "$PROMPT_FILE" && ! -f "$PROMPT_FILE" ]]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

if [[ -n "$SCHEMA_FILE" && ! -f "$SCHEMA_FILE" ]]; then
  echo "Schema file not found: $SCHEMA_FILE" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMP_DIR="$(mktemp -d /tmp/redc-opencode-serve-capture.XXXXXX)"
CONTAINER_NAME="redc-opencode-capture-$(date +%s)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_DIR/share"
cp "$AUTH_FILE" "$TMP_DIR/share/auth.json"

if [[ -n "$PROMPT_FILE" ]]; then
  cp "$PROMPT_FILE" "$TMP_DIR/prompt.txt"
else
  printf '%s\n' "$PROMPT" > "$TMP_DIR/prompt.txt"
fi

if [[ -n "$SCHEMA_FILE" ]]; then
  cp "$SCHEMA_FILE" "$TMP_DIR/schema.json"
fi

DOCKER_ARGS=(
  docker run -d
  --name "$CONTAINER_NAME"
)

if [[ -n "$PORT" ]]; then
  DOCKER_ARGS+=(-p "${PORT}:4096")
else
  DOCKER_ARGS+=(-p "127.0.0.1::4096")
fi

DOCKER_ARGS+=(
  -v "$REPO_PATH:/workspace"
  -v "$TMP_DIR/share:/root/.local/share/opencode"
  -w /workspace
  "$IMAGE"
  serve --hostname 0.0.0.0 --port 4096
)

"${DOCKER_ARGS[@]}" >/dev/null

if [[ -z "$PORT" ]]; then
  PORT="$(docker port "$CONTAINER_NAME" 4096/tcp | sed -E 's#.*:([0-9]+)$#\1#' | head -n1)"
fi

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/global/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:${PORT}/global/health" >/dev/null; then
  echo "Timed out waiting for opencode serve on port ${PORT}" >&2
  docker logs "$CONTAINER_NAME" >&2 || true
  exit 1
fi

PROMPT_CONTENT="$(cat "$TMP_DIR/prompt.txt")"

cd "$ROOT_DIR"
CARGO=(
  bun experiments/opencode-lab/src/capture-session.ts
  --base-url "http://127.0.0.1:${PORT}"
  --directory /workspace
  --prompt "$PROMPT_CONTENT"
  --out-file "$OUT_FILE"
  --model "$MODEL"
)

if [[ -n "$MESSAGES_FILE" ]]; then
  CARGO+=(--messages-file "$MESSAGES_FILE")
fi

if [[ -n "$RESPONSE_FILE" ]]; then
  CARGO+=(--response-file "$RESPONSE_FILE")
fi

if [[ -n "$SCHEMA_FILE" ]]; then
  CARGO+=(--schema-file "$TMP_DIR/schema.json")
fi

if [[ -n "$SYSTEM_PROMPT" ]]; then
  CARGO+=(--system "$SYSTEM_PROMPT")
fi

if [[ -n "$TIMEOUT_MS" ]]; then
  CARGO+=(--timeout-ms "$TIMEOUT_MS")
fi

"${CARGO[@]}"
