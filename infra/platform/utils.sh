teardown_preview_project() {
  local dir="$1"
  local project="$2"

  (cd "${dir}" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/base/compose.yml -f infra/preview/compose.yml down -v --remove-orphans) || true
}
