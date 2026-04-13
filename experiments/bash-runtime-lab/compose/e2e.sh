#!/usr/bin/env bash
set -euo pipefail

port="${BASH_RUNTIME_LAB_PUBLISHED_PORT:-4093}"
base_url="http://127.0.0.1:${port}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"; just compose-down' EXIT

just compose-up

write_json() {
  local path="$1"
  shift
  cat >"${path}" <<JSON
$*
JSON
}

post_run() {
  local request_path="$1"
  local response_path="$2"
  curl -fsS -X POST "${base_url}/runs/execute" \
    -H 'content-type: application/json' \
    --data @"${request_path}" >"${response_path}"
}

assert_json() {
  local response_path="$1"
  local expression="$2"
  bun -e "
    const data = JSON.parse(await Bun.file(process.argv[1]).text());
    if (!(${expression})) {
      console.error('assertion failed:', process.argv[2]);
      process.exit(1);
    }
  " "${response_path}" "${expression}"
}

write_json "${tmp_dir}/journal-request.json" '
{
  "runId": "compose-journal",
  "script": "echo setup > setup.txt\ncat setup.txt\nprintf '\''done\\n'\'' >> setup.txt\n"
}
'

post_run "${tmp_dir}/journal-request.json" "${tmp_dir}/journal-response.json"
assert_json "${tmp_dir}/journal-response.json" "data.result.status === 'completed'"
assert_json "${tmp_dir}/journal-response.json" "data.result.commandCount === 3"
assert_json "${tmp_dir}/journal-response.json" "data.result.journal.filter((event) => event.phase === 'after').length === 3"

mkdir -p "${BASH_RUNTIME_LAB_HOST_DATA_DIR}/workspaces/compose-replay"
printf 'cached\n' >"${BASH_RUNTIME_LAB_HOST_DATA_DIR}/workspaces/compose-replay/replay.txt"

write_json "${tmp_dir}/replay-request.json" '
{
  "runId": "compose-replay",
  "script": "cat replay.txt\n"
}
'

post_run "${tmp_dir}/replay-request.json" "${tmp_dir}/replay-first.json"
post_run "${tmp_dir}/replay-request.json" "${tmp_dir}/replay-second.json"
assert_json "${tmp_dir}/replay-first.json" "data.result.stdout === 'cached\n'"
assert_json "${tmp_dir}/replay-second.json" "data.result.stdout === 'cached\n'"
assert_json "${tmp_dir}/replay-second.json" "data.result.journal.filter((event) => event.phase === 'after').every((event) => event.cached)"

write_json "${tmp_dir}/dependency-first.json" '
{
  "runId": "compose-dependency",
  "script": "echo dep > dep.txt\ncat dep.txt\n",
  "dependencyHashes": {
    "upstream": "hash-a"
  }
}
'

write_json "${tmp_dir}/dependency-second.json" '
{
  "runId": "compose-dependency",
  "script": "echo dep > dep.txt\ncat dep.txt\n",
  "dependencyHashes": {
    "upstream": "hash-b"
  }
}
'

post_run "${tmp_dir}/dependency-first.json" "${tmp_dir}/dependency-first-response.json"
post_run "${tmp_dir}/dependency-second.json" "${tmp_dir}/dependency-second-response.json"
assert_json "${tmp_dir}/dependency-second-response.json" "data.result.journal.filter((event) => event.phase === 'after').some((event) => event.cached === false)"
