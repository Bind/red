#!/usr/bin/env bash
# redc diff <id> — show change diff

id="${1:-}"
require_arg "id" "$id"

body=$(api_get "/api/changes/$id/diff")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

# Diff is raw text — print directly
echo "$body"
