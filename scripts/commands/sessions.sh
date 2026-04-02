#!/usr/bin/env bash
# redc sessions <changeId> — list agent sessions for a change

change_id="${1:-}"
require_arg "changeId" "$change_id"

body=$(api_get "/api/changes/$change_id/sessions")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "redc sessions — change #$change_id"
separator
echo

echo "  $(pad "ID" 8)$(pad "Status" 12)$(pad "Started" 25)$(pad "Duration" 12)"
echo "  $(sep_str "─" 57)"

echo "$body" | jq -r '.[] | "\(.id)\t\(.status // "—")\t\(.started_at // .created_at // "—")\t\(.duration_ms // "—")"' 2>/dev/null | while IFS=$'\t' read -r id status started duration; do
  echo "  $(pad "$id" 8)$(pad "$status" 12)$(pad "$started" 25)$(pad "$duration" 12)"
done
