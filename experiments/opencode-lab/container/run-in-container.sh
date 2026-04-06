#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run-in-container.sh --repo-path <path> [--prompt <text> | --prompt-file <path>] [--model <provider/model>] [--image <name>] [--auth-file <path>] [--build]

Notes:
  - This stages a temporary copy of the host OpenCode auth store, then mounts it
    into the container at /root/.local/share/opencode/auth.json.
  - This uses OpenCode auth, not ~/.codex/auth.json directly.
  - The default model is openai/gpt-5.4 to exercise the subscription-backed path.
EOF
}

REPO_PATH=""
PROMPT=""
PROMPT_FILE=""
MODEL="openai/gpt-5.4"
IMAGE="redc-opencode-lab"
AUTH_FILE="${HOME}/.local/share/opencode/auth.json"
BUILD_IMAGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-path)
      REPO_PATH="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT="${2:-}"
      shift 2
      ;;
    --prompt-file)
      PROMPT_FILE="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --auth-file)
      AUTH_FILE="${2:-}"
      shift 2
      ;;
    --build)
      BUILD_IMAGE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REPO_PATH" ]]; then
  echo "Missing --repo-path" >&2
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$BUILD_IMAGE" -eq 1 ]]; then
  docker build -t "$IMAGE" "$SCRIPT_DIR"
fi

TMP_DIR="$(mktemp -d /tmp/redc-opencode-container.XXXXXX)"
cleanup() {
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

echo "Running opencode in container"
echo "repo: $REPO_PATH"
echo "model: $MODEL"
echo "auth: staged copy of $AUTH_FILE"

docker run --rm \
  -v "$REPO_PATH:/workspace" \
  -v "$TMP_DIR/share:/root/.local/share/opencode" \
  -v "$TMP_DIR/prompt.txt:/tmp/prompt.txt:ro" \
  -w /workspace \
  "$IMAGE" \
  run \
  --model "$MODEL" \
  --format json \
  "$(cat "$TMP_DIR/prompt.txt")"
