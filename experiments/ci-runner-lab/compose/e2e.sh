#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
experiment_dir="$repo_root/experiments/ci-runner-lab"
compose_file="$experiment_dir/docker-compose.yml"
tmp_dir="$(mktemp -d)"
data_dir="$tmp_dir/data"
job_file="$tmp_dir/job.json"
result_file="$tmp_dir/result.json"
logs_file="$tmp_dir/logs.json"

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

cat > "$job_file" <<'EOF'
{
  "repoId": "red/example",
  "commitSha": "0123456789abcdef0123456789abcdef01234567",
  "jobName": "test",
  "env": {
    "JOB_SAMPLE": "compose-e2e"
  },
  "gitCredentialGrant": "compose-grant"
}
EOF

job_id="$(
  curl -fsS http://127.0.0.1:4091/jobs \
    -H 'content-type: application/json' \
    --data @"$job_file" \
    | jq -r '.job.jobId'
)"

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:4091/jobs/$job_id" > "$result_file"
  if jq -e '.job.attempts[-1].status == "success"' "$result_file" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

jq -e '.job.repoId == "red/example"' "$result_file" >/dev/null
jq -e '.job.attempts | length == 1' "$result_file" >/dev/null
jq -e '.job.attempts[0].artifacts[0] | contains("artifacts/result.txt")' "$result_file" >/dev/null

curl -fsS "http://127.0.0.1:4091/jobs/$job_id/attempts/1/logs?after_seq=0" > "$logs_file"
jq -e '.chunks | length > 0' "$logs_file" >/dev/null
jq -e '[.chunks[].text] | join("") | contains("ready")' "$logs_file" >/dev/null
