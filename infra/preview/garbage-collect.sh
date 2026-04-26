#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?usage: garbage-collect.sh <host> [ssh-port]}"
SSH_PORT="${2:-2222}"
PREVIEWS_DIR="/opt/redc-previews"
CADDY_SITE_DIR="/opt/redc-preview-caddy/caddy/sites"
PREVIEW_UTILS_CONTENT="$(cat "$(dirname "$0")/../platform/utils.sh")"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh is required" >&2
  exit 1
fi

repo_from_origin() {
  local origin
  origin="$(git config --get remote.origin.url || true)"
  if [[ -z "${origin}" ]]; then
    echo "error: unable to infer repo id from git remote.origin.url" >&2
    exit 1
  fi

  origin="${origin%.git}"
  origin="${origin#git@github.com:}"
  origin="${origin#ssh://git@github.com/}"
  origin="${origin#https://github.com/}"
  origin="${origin#http://github.com/}"

  if [[ "${origin}" != */* ]]; then
    echo "error: unsupported remote.origin.url '${origin}'" >&2
    exit 1
  fi

  printf '%s\n' "${origin}"
}

repo_id="$(repo_from_origin)"
active_slugs="$(
  gh pr list -R "${repo_id}" --state open --limit 200 --json number --jq '.[].number' \
    | sed 's/^/pr-/'
)"
active_slugs_b64="$(printf '%s' "${active_slugs}" | base64 | tr -d '\n')"

echo "==> Garbage collecting closed preview stacks on ${HOST}"
ssh -p "${SSH_PORT}" -o StrictHostKeyChecking=accept-new "root@${HOST}" \
  ACTIVE_SLUGS_B64="${active_slugs_b64}" \
  PREVIEWS_DIR="${PREVIEWS_DIR}" \
  CADDY_SITE_DIR="${CADDY_SITE_DIR}" \
  "bash -s" <<REMOTE
set -euo pipefail

${PREVIEW_UTILS_CONTENT}

active_slugs_file=\$(mktemp)
cleanup() {
  rm -f "\${active_slugs_file}"
}
trap cleanup EXIT

printf '%s' "\${ACTIVE_SLUGS_B64}" | base64 -d > "\${active_slugs_file}"

is_active_slug() {
  local slug="\$1"
  grep -Fxq "\${slug}" "\${active_slugs_file}"
}

removed_any=0

if [ -d "\${PREVIEWS_DIR}" ]; then
  while IFS= read -r slug; do
    [ -n "\${slug}" ] || continue
    if is_active_slug "\${slug}"; then
      continue
    fi

    dir="\${PREVIEWS_DIR}/\${slug}"
    project="preview-\${slug}"
    echo "==> Evicting inactive preview \${slug}"
    teardown_preview_project "\${dir}" "\${project}"
    rm -rf "\${dir}"
    rm -f "\${CADDY_SITE_DIR}/\${slug}.caddy"
    removed_any=1
  done < <(find "\${PREVIEWS_DIR}" -mindepth 1 -maxdepth 1 -type d -name 'pr-*' -printf '%f\n' | sort)
fi

if [ -d "\${CADDY_SITE_DIR}" ]; then
  while IFS= read -r site; do
    slug="\${site%.caddy}"
    if is_active_slug "\${slug}"; then
      continue
    fi

    echo "==> Removing stale preview caddy site \${site}"
    rm -f "\${CADDY_SITE_DIR}/\${site}"
    removed_any=1
  done < <(find "\${CADDY_SITE_DIR}" -mindepth 1 -maxdepth 1 -type f -name 'pr-*.caddy' -printf '%f\n' | sort)
fi

if docker ps --format '{{.Names}}' | grep -qx preview-caddy; then
  docker exec preview-caddy caddy reload --config /etc/caddy/preview.Caddyfile || true
fi

if [ "\${removed_any}" -eq 1 ]; then
  docker system prune -af --volumes || true
  docker builder prune -af || true
fi
REMOTE

echo "==> Preview garbage collection complete"
