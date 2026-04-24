#!/usr/bin/env bash
# redc change <id> — show change detail

id="${1:-}"
require_arg "id" "$id"

body=$(api_get "/api/changes/$id")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

repo=$(echo "$body" | jq -r '.repo // "—"')
branch=$(echo "$body" | jq -r '.branch // "—"')
status=$(echo "$body" | jq -r '.status // "—"')
confidence=$(echo "$body" | jq -r '.confidence // "—"')
created_by=$(echo "$body" | jq -r '.created_by // "—"')
summary=$(echo "$body" | jq -r '.summary // "—"')
updated_at=$(echo "$body" | jq -r '.updated_at // "—"')

echo "redc change #$id"
separator
echo
echo "  Repo:        $repo"
echo "  Branch:      $branch"
echo "  Status:      $status"
echo "  Confidence:  $confidence"
echo "  Created by:  $created_by"
echo "  Updated:     $updated_at"
echo
echo "Summary:"
echo "  $summary"
