#!/usr/bin/env bash
set -euo pipefail

port="${BASH_RUNTIME_LAB_PUBLISHED_PORT:-4093}"
base_url="http://127.0.0.1:${port}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"; just compose-down' EXIT

just compose-up

cat >"${tmp_dir}/request.json" <<'JSON'
{
  "runId": "compose-smoke",
  "script": "echo setup > setup.txt\n# @durable build\ncount=$(cat \"$BASH_RUNTIME_WORKSPACE/setup.txt\" | wc -l | tr -d ' ')\nprintf '%s' \"$count\" | durable_set line_count\nprintf 'build:%s\\n' \"$(durable_get line_count)\"\n# @enddurable\n# @durable publish\nprintf 'publish:%s\\n' \"$(durable_get line_count)\"\n# @enddurable\n"
}
JSON

first_response="$(curl -fsS -X POST "${base_url}/runs/execute" \
  -H 'content-type: application/json' \
  --data @"${tmp_dir}/request.json")"

echo "${first_response}" | grep '"status":"completed"' >/dev/null
echo "${first_response}" | grep '"cached":false' >/dev/null

second_response="$(curl -fsS -X POST "${base_url}/runs/execute" \
  -H 'content-type: application/json' \
  --data @"${tmp_dir}/request.json")"

echo "${second_response}" | grep '"cached":true' >/dev/null
