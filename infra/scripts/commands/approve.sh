#!/usr/bin/env bash
# redc approve <id> — approve a change

id="${1:-}"
require_arg "id" "$id"

body=$(api_post "/api/changes/$id/approve")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "Change #$id approved."
