teardown_preview_project() {
  local dir="$1"
  local project="$2"

  if [ -f "${dir}/infra/base/compose.yml" ] && [ -f "${dir}/infra/preview/compose.yml" ]; then
    (cd "${dir}" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/base/compose.yml -f infra/preview/compose.yml down -v --remove-orphans) || true
    return 0
  fi

  if [ -f "${dir}/infra/compose/runtime.yml" ] && [ -f "${dir}/infra/compose/preview.yml" ]; then
    (cd "${dir}" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/compose/runtime.yml -f infra/compose/preview.yml down -v --remove-orphans) || true
    return 0
  fi

  if [ -f "${dir}/infra/compose/preview.yml" ]; then
    (cd "${dir}" && COMPOSE_PROJECT_NAME="${project}" docker compose -f infra/compose/preview.yml down -v --remove-orphans) || true
    return 0
  fi

  ids=$(docker ps -aq --filter label=com.docker.compose.project="${project}")
  if [ -n "${ids}" ]; then
    docker rm -f ${ids} || true
  fi

  vids=$(docker volume ls -q --filter label=com.docker.compose.project="${project}")
  if [ -n "${vids}" ]; then
    docker volume rm -f ${vids} || true
  fi

  nids=$(docker network ls -q --filter label=com.docker.compose.project="${project}")
  if [ -n "${nids}" ]; then
    docker network rm ${nids} || true
  fi
}
