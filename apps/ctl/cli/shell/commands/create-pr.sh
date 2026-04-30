#!/usr/bin/env bash
# red create-pr <repo> <branch> <title> [--body text] — create PR from branch

repo="${1:-}"
branch="${2:-}"
title="${3:-}"
require_arg "repo" "$repo"
require_arg "branch" "$branch"
require_arg "title" "$title"
shift 3

pr_body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --body) pr_body="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

payload=$(jq -n \
  --arg repo "$repo" \
  --arg branch "$branch" \
  --arg title "$title" \
  --arg body "$pr_body" \
  '{repo: $repo, branch: $branch, title: $title, body: $body}')

result=$(api_post "/api/branches/create-pr" "$payload")

if [[ "$JSON_OUTPUT" == "true" ]]; then
  echo "$result" | print_json
  exit 0
fi

pr_url=$(echo "$result" | jq -r '.html_url // .url // "—"' 2>/dev/null)
echo "PR created: $pr_url"
