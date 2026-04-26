#!/usr/bin/env bash
# red retry-merge <id> — retry failed merge

id="${1:-}"
require_arg "id" "$id"

body=$(api_post "/api/changes/$id/retry-merge")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "Merge retry queued for change #$id."
