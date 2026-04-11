#!/usr/bin/env bash
set -euo pipefail

repo_root="$(pwd)"
compose_file="$repo_root/docker-compose.yml"
published_port="${SMITHERS_LAB_PUBLISHED_PORT:-4090}"
data_dir="${SMITHERS_LAB_HOST_DATA_DIR:-$repo_root/.tmp-compose-data}"

mkdir -p "$data_dir"

export SMITHERS_LAB_HOST_DATA_DIR="$data_dir"
export SMITHERS_LAB_OPENAI_API_KEY="${SMITHERS_LAB_OPENAI_API_KEY:-dummy}"
export SMITHERS_LAB_OPENAI_MODEL="${SMITHERS_LAB_OPENAI_MODEL:-gpt-5-mini}"

cleanup() {
  docker compose -f "$compose_file" down -v --remove-orphans
}

trap cleanup EXIT

docker compose -f "$compose_file" up --build -d
until curl -fsS "http://127.0.0.1:${published_port}/health" >/dev/null; do sleep 1; done
curl -fsS "http://127.0.0.1:${published_port}/health"
