#!/usr/bin/env bash
# red requeue-summary <id> — retry failed summary

id="${1:-}"
require_arg "id" "$id"

body=$(api_post "/api/changes/$id/requeue-summary")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "Summary requeued for change #$id."
