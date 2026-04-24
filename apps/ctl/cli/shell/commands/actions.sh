#!/usr/bin/env bash
# redc actions — list claw actions

body=$(api_get "/api/claw/actions")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "redc actions"
separator
echo

echo "  $(pad "ID" 6)$(pad "Name" 30)$(pad "Description" 40)"
echo "  $(sep_str "─" 76)"

echo "$body" | jq -r '.[] | "\(.id)\t\(.name // "—")\t\(.description // "—")"' 2>/dev/null | while IFS=$'\t' read -r id name desc; do
  echo "  $(pad "$id" 6)$(pad "$(truncate_str "$name" 28)" 30)$(pad "$(truncate_str "$desc" 38)" 40)"
done
