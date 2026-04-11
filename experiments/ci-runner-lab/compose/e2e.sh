#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
experiment_dir="$repo_root/experiments/ci-runner-lab"
compose_file="$experiment_dir/docker-compose.yml"
tmp_dir="$(mktemp -d)"
data_dir="$tmp_dir/data"
run_file="$tmp_dir/run.json"
result_file="$tmp_dir/result.json"

cleanup() {
  docker compose -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$data_dir"

export CI_RUNNER_LAB_HOST_DATA_DIR="$data_dir"
export CI_RUNNER_LAB_MAX_CONCURRENT_RUNS=2
export CI_RUNNER_LAB_STEP_TIMEOUT_MS=15000
export CI_RUNNER_LAB_PUBLISHED_PORT=4091

docker compose -f "$compose_file" up --build -d

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4091/health >/dev/null; then
    break
  fi
  sleep 1
done

cat > "$run_file" <<'EOF'
{
  "workflowName": "compose-e2e",
  "repository": "redc/example",
  "ref": "refs/heads/main",
  "steps": [
    { "name": "seed", "run": "echo warmup" },
    { "name": "artifact", "run": "echo ready > artifact.txt && cat artifact.txt" }
  ]
}
EOF

run_id="$(
  curl -fsS http://127.0.0.1:4091/runs \
    -H 'content-type: application/json' \
    --data @"$run_file" \
    | jq -r '.run.id'
)"

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:4091/runs/$run_id" > "$result_file"
  if jq -e '.run.status == "success"' "$result_file" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

jq -e '.run.workflowName == "compose-e2e"' "$result_file" >/dev/null
jq -e '.run.stepResults | length == 2' "$result_file" >/dev/null
jq -e '.run.stepResults[1].stdout | contains("ready")' "$result_file" >/dev/null
