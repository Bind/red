#!/usr/bin/env bash
# red events <changeId> — stream agent events (SSE)

change_id="${1:-}"
require_arg "changeId" "$change_id"

if [[ "$JSON_OUTPUT" == "true" ]]; then
  # In JSON mode, output raw SSE data lines
  api_stream "/api/changes/$change_id/agent-events" | while IFS= read -r line; do
    case "$line" in
      data:*) echo "${line#data: }" ;;
    esac
  done
  exit 0
fi

echo "red events — change #$change_id (streaming, ctrl-c to stop)"
separator
echo

api_stream "/api/changes/$change_id/agent-events" | while IFS= read -r line; do
  case "$line" in
    data:*)
      data="${line#data: }"
      type=$(echo "$data" | jq -r '.type // .event // ""' 2>/dev/null)
      msg=$(echo "$data" | jq -r '.message // .data // .' 2>/dev/null)
      if [[ -n "$type" && "$type" != "null" ]]; then
        echo "  [$type] $msg"
      else
        echo "  $msg"
      fi
      ;;
  esac
done
