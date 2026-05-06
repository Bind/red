teardown_preview_project() {
  local dir="$1"
  local project="$2"

  (cd "${dir}" && COMPOSE_PROJECT_NAME="${project}" docker compose \
    -f infra/base/compose.yml -f infra/preview/compose.yml \
    down -v --remove-orphans) || true

  # best-effort: clean up any containers/volumes/networks the compose call missed
  docker ps -aq --filter label=com.docker.compose.project="${project}" \
    | xargs -r docker rm -f || true
  docker volume ls -q --filter label=com.docker.compose.project="${project}" \
    | xargs -r docker volume rm -f || true
  docker network ls -q --filter label=com.docker.compose.project="${project}" \
    | xargs -r docker network rm || true
}
