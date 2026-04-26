#!/usr/bin/env bash
# red health — health check

body=$(api_get "/health")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

echo "red health"
separator
echo
echo "  Status: ok"
