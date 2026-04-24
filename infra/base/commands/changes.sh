#!/usr/bin/env bash
# redc changes — list review queue

body=$(api_get "/api/review")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

count=$(echo "$body" | jq 'length' 2>/dev/null || echo "?")

echo "redc changes"
separator
echo

if [[ "$count" == "0" ]]; then
  echo "  Review queue: empty"
  exit 0
fi

echo "Review queue ($count):"
echo "  $(pad "ID" 6)$(pad "Repo" 25)$(pad "Branch" 20)$(pad "Confidence" 14)$(pad "By" 8)"
echo "  $(sep_str "─" 73)"

echo "$body" | jq -r '.[] | "\(.id)\t\(.repo)\t\(.branch)\t\(.confidence // "—")\t\(.created_by // "—")"' 2>/dev/null | while IFS=$'\t' read -r id repo branch conf by; do
  echo "  $(pad "$id" 6)$(pad "$(truncate_str "$repo" 23)" 25)$(pad "$(truncate_str "$branch" 18)" 20)$(pad "$conf" 14)$(pad "$by" 8)"
done
