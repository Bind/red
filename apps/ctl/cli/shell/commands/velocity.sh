#!/usr/bin/env bash
# red velocity — merge velocity metrics

hours=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) hours="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

path="/api/velocity"
[[ -n "$hours" ]] && path="${path}?hours=${hours}"

body=$(api_get "$path")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$body" | print_json
  exit 0
fi

merged=$(echo "$body" | jq -r '.merged // 0' 2>/dev/null || echo "?")
pending=$(echo "$body" | jq -r '.pending_review // 0' 2>/dev/null || echo "?")

echo "red velocity"
separator
echo
echo "Merge velocity (${hours:-24}h):"
echo "  Merged:          $merged"
echo "  Pending review:  $pending"
