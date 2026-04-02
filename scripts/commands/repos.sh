#!/usr/bin/env bash
# redc repos — list repos

body=$(api_get "/api/repos")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "redc repos"
separator
echo

echo "  $(pad "Repo" 40)$(pad "Source" 10)"
echo "  $(sep_str "─" 50)"

echo "$body" | jq -r '.[] | "\(.full_name // .name)\t\(.source // "—")"' 2>/dev/null | while IFS=$'\t' read -r name source; do
  echo "  $(pad "$name" 40)$(pad "$source" 10)"
done
