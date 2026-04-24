#!/usr/bin/env sh
set -eu

workspace_root="${1:-/app}"
stamp_dir="${2:-$workspace_root/node_modules/.cache}"
stamp_file="$stamp_dir/redc-bun-install.hash"

mkdir -p "$stamp_dir"

manifest_hash="$(
  (
    cd "$workspace_root"
    {
      printf '%s\n' "bun.lock" "package.json"
      find apps pkg workflows -mindepth 2 -maxdepth 2 -name package.json -print 2>/dev/null
    } | LC_ALL=C sort | while IFS= read -r path; do
      [ -f "$path" ] || continue
      sha256sum "$path"
    done | sha256sum | awk '{print $1}'
  )
)"

current_hash=""
if [ -f "$stamp_file" ]; then
  current_hash="$(cat "$stamp_file")"
fi

if [ "$manifest_hash" = "$current_hash" ] && [ -d "$workspace_root/node_modules" ]; then
  echo "Skipping bun install; workspace deps unchanged."
  exit 0
fi

echo "Installing workspace deps with bun..."
cd "$workspace_root"
bun install --frozen-lockfile
printf '%s\n' "$manifest_hash" > "$stamp_file"
