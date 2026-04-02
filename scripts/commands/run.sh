#!/usr/bin/env bash
# redc run <runId> — show run detail

run_id="${1:-}"
require_arg "runId" "$run_id"

body=$(api_get "/api/claw/runs/$run_id")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

id=$(echo "$body" | jq -r '.id // .run_id // "—"')
action=$(echo "$body" | jq -r '.action_name // .action // "—"')
status=$(echo "$body" | jq -r '.status // "—"')
started=$(echo "$body" | jq -r '.started_at // .created_at // "—"')
finished=$(echo "$body" | jq -r '.finished_at // .completed_at // "—"')

echo "redc run #$id"
separator
echo
echo "  Action:    $action"
echo "  Status:    $status"
echo "  Started:   $started"
echo "  Finished:  $finished"
