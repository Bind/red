#!/usr/bin/env bash
# redc branches <owner/repo> — list branches for a repo

repo="${1:-}"
require_arg "owner/repo" "$repo"

body=$(api_get "/api/branches?repo=${repo}")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "redc branches — $repo"
separator
echo

echo "  $(pad "Branch" 40)$(pad "Updated" 25)"
echo "  $(sep_str "─" 65)"

echo "$body" | jq -r '.[] | "\(.name)\t\(.commit.timestamp // .updated_at // "—")"' 2>/dev/null | while IFS=$'\t' read -r name updated; do
  echo "  $(pad "$(truncate_str "$name" 38)" 40)$(pad "$updated" 25)"
done
