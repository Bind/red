#!/usr/bin/env bash
# redc jobs — pending job count

body=$(api_get "/api/jobs/pending")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

count=$(echo "$body" | jq -r '.count // .pending // .' 2>/dev/null || echo "$body")

echo "redc jobs"
separator
echo
echo "  Pending jobs: $count"
