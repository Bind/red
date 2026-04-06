#!/usr/bin/env bash
# redc health — health check

body=$(api_get "/health")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "redc health"
separator
echo
echo "  Status: ok"
