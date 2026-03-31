# redc — agent-native code forge

set dotenv-load

mod infra
mod e2e

# Default: show available commands
default:
    @just --list --unsorted

# Local stack configuration
FORGEJO_URL := env("FORGEJO_URL", "http://localhost:3001")
REDC_PORT := env("REDC_PORT", "3002")
WEB_PORT := "5173"

# One-time local bootstrap: Forgejo admin, token, repo, webhook, and app env
setup:
    ./scripts/setup-dev-env.sh

# Start all local services in Docker, bootstrapping first if needed
up:
    ./scripts/setup-dev-env.sh

# Stop all local services
down:
    just infra down

# Rebuild app containers and the Codex runner image
build:
    docker compose build
    docker build -t redc-codex-runner codex-runner/

# Show local service status
ps:
    docker compose ps

# Tail logs for one service, or pick one with fzf if omitted
logs service="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ service }}" ]; then
        docker compose logs -f {{ service }}
    else
        selected_service="$(
            docker compose config --services | fzf --prompt='service> ' --height=40% --reverse
        )"
        [ -n "$selected_service" ] || exit 0
        docker compose logs -f "$selected_service"
    fi

# Open a shell inside a running service, or pick one with fzf
shell service="":
    #!/usr/bin/env bash
    set -euo pipefail
    selected_service="{{ service }}"
    if [ -z "$selected_service" ]; then
        selected_service="$(
            docker compose config --services | fzf --prompt='service> ' --height=40% --reverse
        )"
    fi
    [ -n "$selected_service" ] || exit 0
    docker compose exec "$selected_service" sh

# Run a command inside a running service, or pick one with fzf
exec service="" *cmd:
    #!/usr/bin/env bash
    set -euo pipefail
    selected_service="{{ service }}"
    if [ -z "$selected_service" ]; then
        selected_service="$(
            docker compose config --services | fzf --prompt='service> ' --height=40% --reverse
        )"
    fi
    [ -n "$selected_service" ] || exit 0
    docker compose exec "$selected_service" {{ cmd }}

# Run backend tests inside Docker
test:
    docker compose exec redc-api bun test

# Run type checking inside Docker
typecheck:
    docker compose exec redc-api bunx tsc --noEmit

# Build the production frontend bundle inside Docker
web-build:
    docker compose exec redc-web bun run build

# Full local verification
verify: typecheck test

# ── CLI ─────────────────────────────────────────────────

# Bootstrap Forgejo user, repo, and git remote from GitHub identity
bootstrap:
    docker compose exec redc-api bun run src/cli/index.ts bootstrap

# Show merge velocity and review queue
status:
    docker compose exec redc-api bun run src/cli/index.ts status

# Browse all Forgejo repos with fzf
repos:
    @curl -sf "{{ FORGEJO_URL }}/api/v1/admin/repos?limit=50&token=$FORGEJO_TOKEN" \
        | bun -e 'const repos=await Bun.stdin.json();for(const r of repos)console.log(r.full_name+"\t"+r.html_url+"\t"+(r.description||""))' \
        | fzf --delimiter='\t' --with-nth=1 --preview='echo "URL: {2}\nDesc: {3}"' \
        | cut -f2

# Dry-run policy evaluation
policy-test path=".redc/policy.yaml":
    docker compose exec redc-api bun run src/cli/index.ts policy test {{ path }}
