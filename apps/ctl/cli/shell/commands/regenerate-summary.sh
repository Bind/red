#!/usr/bin/env bash
# red regenerate-summary <id> — regenerate summary

id="${1:-}"
require_arg "id" "$id"

body=$(api_post "/api/changes/$id/regenerate-summary")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "Summary regeneration queued for change #$id."
