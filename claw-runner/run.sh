#!/bin/bash
set -euo pipefail

WORKDIR="/work/repo"
REQUEST_FILE="/input/request.json"
HOST_OUTPUT_DIR="/output"
EVENTS_FILE="$HOST_OUTPUT_DIR/agent-events.jsonl"
RESULT_FILE="$HOST_OUTPUT_DIR/result.json"
AUTH_DIR="/root/.local/share/opencode"
CONFIG_FILE="$WORKDIR/opencode.json"
OPENCODE_DIR="$WORKDIR/.opencode"
TOOLS_DIR="$OPENCODE_DIR/tools"
PACKAGE_FILE="$OPENCODE_DIR/package.json"
DONE_TOOL_FILE="$TOOLS_DIR/done.ts"

rm -rf "$WORKDIR"
mkdir -p "$(dirname "$WORKDIR")" "$HOST_OUTPUT_DIR"

json_field() {
  local field="$1"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const field = process.argv[2];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const value = field.split(".").reduce((acc, key) => acc == null ? undefined : acc[key], data);
    if (value === undefined || value === null) process.exit(1);
    if (typeof value === "string") process.stdout.write(value);
    else process.stdout.write(JSON.stringify(value));
  ' "$REQUEST_FILE" "$field"
}

json_field_optional() {
  local field="$1"
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const field = process.argv[2];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const value = field.split(".").reduce((acc, key) => acc == null ? undefined : acc[key], data);
    if (value === undefined || value === null) process.exit(0);
    if (typeof value === "string") process.stdout.write(value);
    else process.stdout.write(JSON.stringify(value));
  ' "$REQUEST_FILE" "$field"
}

REPO_URL="${REPO_URL:-}"
HEAD_REF="${HEAD_REF:-}"
BASE_REF="${BASE_REF:-}"
TASK_PROMPT="${TASK_PROMPT:-}"

if [ -f "$REQUEST_FILE" ]; then
  REPO_URL="${REPO_URL:-$(json_field "repoUrl")}"
  HEAD_REF="$(json_field "headRef")"
  BASE_REF="$(json_field_optional "baseRef" || true)"
  TASK_PROMPT="$(json_field "instructions")"
fi

: "${REPO_URL:?Missing repoUrl/REPO_URL}"
: "${HEAD_REF:?Missing headRef/HEAD_REF}"
: "${TASK_PROMPT:?Missing instructions/TASK_PROMPT}"

echo "Cloning $REPO_URL..." >&2
git clone --quiet "$REPO_URL" "$WORKDIR"
cd "$WORKDIR"
mkdir -p "$TOOLS_DIR"

echo "Checking out $HEAD_REF..." >&2
git fetch --quiet origin "$HEAD_REF" || true
git checkout --quiet "$HEAD_REF"

if [ -n "$BASE_REF" ]; then
  git fetch --quiet origin "$BASE_REF" || true
fi

cat > "$CONFIG_FILE" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "allow",
    "bash": "deny",
    "edit": "deny",
    "webfetch": "deny"
  }
}
EOF

cat > "$PACKAGE_FILE" <<'EOF'
{
  "dependencies": {
    "@opencode-ai/plugin": "^1.0.0"
  }
}
EOF

cat > "$DONE_TOOL_FILE" <<'EOF'
import { writeFile } from "node:fs/promises"
import { tool } from "@opencode-ai/plugin"

const annotationSchema = tool.schema.object({
  text: tool.schema.string(),
  files: tool.schema.array(tool.schema.string()),
  type: tool.schema.enum(["new_module", "refactor", "bugfix", "config", "change"]),
})

export default tool({
  description: "Persist the final redc summary JSON and mark the batch run as complete.",
  args: {
    title: tool.schema.string(),
    what_changed: tool.schema.string(),
    risk_assessment: tool.schema.string(),
    affected_modules: tool.schema.array(tool.schema.string()),
    recommended_action: tool.schema.enum(["approve", "review", "block"]),
    annotations: tool.schema.array(annotationSchema),
  },
  async execute(args) {
    const resultPath = process.env.DONE_RESULT_PATH
    if (!resultPath) {
      throw new Error("Missing DONE_RESULT_PATH")
    }

    await writeFile(resultPath, JSON.stringify(args, null, 2), "utf8")
    return "Summary saved. Batch run can finish now."
  },
})
EOF

echo "Running OpenCode..." >&2
DONE_RESULT_PATH="$RESULT_FILE" opencode run \
  --model "${OPENCODE_MODEL:-openai/gpt-5.4}" \
  --format json \
  "$TASK_PROMPT" \
  | tee "$EVENTS_FILE"

if [ ! -s "$RESULT_FILE" ]; then
node -e '
  const fs = require("fs");
  const eventsPath = process.argv[1];
  const resultPath = process.argv[2];
  const lines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean);
  let text = "";
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.part?.text === "string") {
        text += event.part.text;
      }
    } catch {}
  }
  if (!text.trim()) {
    console.error("OpenCode did not emit a text result");
    process.exit(1);
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    console.error("OpenCode result did not contain JSON");
    process.exit(1);
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  fs.writeFileSync(resultPath, JSON.stringify(parsed, null, 2));
 ' "$EVENTS_FILE" "$RESULT_FILE"
fi
