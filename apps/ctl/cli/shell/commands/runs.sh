#!/usr/bin/env bash
# red runs — list recent agent runs

limit=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) limit="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

path="/api/claw/runs"
[[ -n "$limit" ]] && path="${path}?limit=${limit}"

body=$(api_get "$path")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "red runs"
separator
echo

echo "  $(pad "ID" 8)$(pad "Action" 25)$(pad "Status" 12)$(pad "Started" 25)"
echo "  $(sep_str "─" 70)"

echo "$body" | jq -r '.[] | "\(.id // .run_id)\t\(.action_name // .action // "—")\t\(.status // "—")\t\(.started_at // .created_at // "—")"' 2>/dev/null | while IFS=$'\t' read -r id action status started; do
  echo "  $(pad "$id" 8)$(pad "$(truncate_str "$action" 23)" 25)$(pad "$status" 12)$(pad "$started" 25)"
done
