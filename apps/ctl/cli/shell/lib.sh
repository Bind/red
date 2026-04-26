#!/usr/bin/env bash
# red CLI shared helpers

RED_API="${RED_API_URL:-http://localhost:3000}"
JSON_OUTPUT=false

# ── Output helpers ──────────────────────────────────────────────

die() {
  echo "error: $*" >&2
  exit 1
}

require_arg() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || die "missing required argument: <$name>"
}

print_json() {
  if command -v jq &>/dev/null; then
    jq .
  else
    cat
  fi
}

# Pad string to fixed width (truncates if longer)
pad() {
  local str="$1" width="$2"
  printf "%-${width}s" "${str:0:$width}"
}

# Truncate with ellipsis
truncate_str() {
  local str="$1" max="$2"
  if [[ ${#str} -le $max ]]; then
    printf '%s' "$str"
  else
    printf '%s' "${str:0:$((max-1))}.."
  fi
}

# Print a separator line
separator() {
  local char="${1:-═}" count="${2:-50}"
  printf '%0.s'"$char" $(seq 1 "$count")
  echo
}

# Return separator string (for use in $())
sep_str() {
  local char="${1:-─}" count="${2:-50}"
  printf '%0.s'"$char" $(seq 1 "$count")
}

# Check if stdout is a terminal
is_tty() {
  [[ -t 1 ]]
}

# ── API helpers ─────────────────────────────────────────────────

api_get() {
  local path="$1"
  local url="${RED_API}${path}"
  local http_code body

  body=$(curl -sS -w '\n%{http_code}' "$url" 2>&1) || die "connection refused — is red running? ($url)"
  http_code=$(echo "$body" | tail -n1)
  body=$(echo "$body" | sed '$d')

  if [[ "$http_code" -ge 400 ]]; then
    die "HTTP $http_code from $path: $body"
  fi

  echo "$body"
}

api_post() {
  local path="$1"
  local data="${2:-}"
  local url="${RED_API}${path}"
  local http_code body
  local -a curl_args=(-sS -X POST)

  if [[ -n "$data" ]]; then
    curl_args+=(-H 'Content-Type: application/json' -d "$data")
  fi

  body=$(curl "${curl_args[@]}" -w '\n%{http_code}' "$url" 2>&1) || die "connection refused — is red running? ($url)"
  http_code=$(echo "$body" | tail -n1)
  body=$(echo "$body" | sed '$d')

  if [[ "$http_code" -ge 400 ]]; then
    die "HTTP $http_code from $path: $body"
  fi

  echo "$body"
}

api_stream() {
  local path="$1"
  local url="${RED_API}${path}"
  curl -sS -N -H 'Accept: text/event-stream' "$url" 2>/dev/null || die "connection refused — is red running? ($url)"
}
