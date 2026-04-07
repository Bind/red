#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
experiment_dir="$repo_root/experiments/git-mirror-canary"
compose_file="$experiment_dir/docker-compose.yml"
tmp_dir="$(mktemp -d)"
work_dir="$tmp_dir/work"
config_dir="$tmp_dir/config"
data_dir="$tmp_dir/data"
source_bare="$data_dir/source.git"
target_bare="$data_dir/target.git"
status_file="$tmp_dir/status.json"

cleanup() {
  docker compose -f "$compose_file" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$work_dir" "$config_dir" "$data_dir"

git init --bare "$source_bare" >/dev/null
git init --bare "$target_bare" >/dev/null
git init "$work_dir" >/dev/null
git -C "$work_dir" config user.name "git mirror canary"
git -C "$work_dir" config user.email "git-mirror-canary@redc.local"
cat > "$work_dir/README.md" <<'EOF'
# git mirror canary
EOF
git -C "$work_dir" add README.md
git -C "$work_dir" commit -m "seed repo" >/dev/null
git -C "$work_dir" branch -M main
git -C "$work_dir" remote add origin "$source_bare"
git -C "$work_dir" push -u origin main >/dev/null

cat > "$config_dir/repos.json" <<EOF
[
  {
    "id": "e2e/source",
    "sourceUrl": "/data/source.git",
    "targetUrl": "/data/target.git",
    "trackedRef": "refs/heads/main",
    "pollIntervalMs": 1000
  }
]
EOF

export GIT_MIRROR_CANARY_HOST_CONFIG_DIR="$config_dir"
export GIT_MIRROR_CANARY_HOST_DATA_DIR="$data_dir"
export GIT_MIRROR_CANARY_POLL_INTERVAL_MS=1000
export GIT_MIRROR_CANARY_PUBLISHED_PORT=4080

docker compose -f "$compose_file" up --build -d

for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4080/health >/dev/null; then
    break
  fi
  sleep 1
done

for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4080/status > "$status_file"
  if jq -e '.repos[0].lastRunStatus == "success"' "$status_file" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

source_sha="$(git --git-dir "$source_bare" rev-parse refs/heads/main)"
target_sha="$(git --git-dir "$target_bare" rev-parse refs/heads/main)"
[ "$source_sha" = "$target_sha" ]

cat > "$work_dir/CHANGELOG.md" <<'EOF'
initial follow-up
EOF
git -C "$work_dir" add CHANGELOG.md
git -C "$work_dir" commit -m "follow up" >/dev/null
git -C "$work_dir" push origin main >/dev/null

updated_source_sha="$(git -C "$work_dir" rev-parse HEAD)"

for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:4080/status > "$status_file"
  current_source="$(jq -r '.repos[0].lastSourceHead // ""' "$status_file")"
  current_target="$(jq -r '.repos[0].lastTargetHead // ""' "$status_file")"
  if [ "$current_source" = "$updated_source_sha" ] && [ "$current_target" = "$updated_source_sha" ]; then
    break
  fi
  sleep 1
done

final_target_sha="$(git --git-dir "$target_bare" rev-parse refs/heads/main)"
[ "$updated_source_sha" = "$final_target_sha" ]
