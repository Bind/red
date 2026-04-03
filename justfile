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

# Rebuild app containers and the Claw runner image
build:
    docker compose build
    docker build -t redc-claw-runner claw-runner/

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

# Run a local self-hosted Rivet Engine
rivet-engine:
    docker run --rm --name redc-rivet-engine -p 6420:6420 rivetdev/engine

# Run the Pi smoke actor runner against Rivet Engine
rivet-pi-runner:
    cd experiments/rivet-lab && bun run pi:rivet:runner

# Execute the Pi smoke action and print inspector payloads
rivet-pi-smoke prompt="Respond with exactly OK":
    cd experiments/rivet-lab && bun run pi:rivet:smoke {{prompt}}

# Prototype the summary workflow through the Rivet actor
rivet-summary-smoke branch="HEAD" base_ref="main" confidence="needs_review":
    cd experiments/rivet-lab && bun run summary:rivet:smoke {{branch}} {{base_ref}} {{confidence}}

# Run the git server/manual SDK CLI
git-server-manual *args:
    cd git-server && bun src/manual/cli.ts {{args}}

# Run tests for the git server package
git-server-test:
    cd git-server && bun test

# Run the live git-backed integration harness
git-server-integration:
    cd git-server && bun src/manual/cli.ts integration

# Run the live git-backed integration test
git-server-integration-test:
    cd git-server && GIT_SERVER_RUN_INTEGRATION=1 bun test src/tests/integration.test.ts
    cd git-server && GIT_SERVER_RUN_INTEGRATION=1 bun test src/tests/auth-integration.test.ts

# Start git server dependencies and service from the root compose stack
git-server-up:
    docker compose up --build git-server minio minio-init

# Stop the git server service from the root compose stack
git-server-down:
    docker compose rm -sf git-server minio-init

# Install dependencies for the isolated OpenCode spike
opencode-lab-install:
    cd experiments/opencode-lab && bun install

# Start an opencode server rooted at a given repo path
opencode-lab-serve repo_path *args:
    cd experiments/opencode-lab && bun src/serve-repo.ts {{repo_path}} {{args}}

# Run manual SDK experiments against an opencode server
opencode-lab-manual *args:
    cd experiments/opencode-lab && bun src/manual.ts {{args}}

# Build the isolated opencode manual-test container
opencode-lab-container-build:
    docker build -t redc-opencode-lab experiments/opencode-lab/container

# Run a manual container test against a mounted repo using staged OpenCode auth
opencode-lab-container-test repo_path prompt_file model="openai/gpt-5.4":
    ./experiments/opencode-lab/container/run-in-container.sh --repo-path {{repo_path}} --prompt-file {{prompt_file}} --model {{model}}

# Start opencode serve in a container, capture the full raw session event stream to JSONL
opencode-lab-serve-capture repo_path prompt_file out_file model="openai/gpt-5.4":
    ./experiments/opencode-lab/container/run-serve-capture.sh --repo-path {{repo_path}} --prompt-file {{prompt_file}} --out-file {{out_file}} --model {{model}}

# Manual PR summary workflow using a cloned repo plus containerized opencode serve
opencode-lab-pr-summary repo_url base_ref head_ref out_dir model="openai/gpt-5.4":
    bun experiments/opencode-lab/src/pr-summary-manual.ts --repo-url {{repo_url}} --base-ref {{base_ref}} --head-ref {{head_ref}} --out-dir {{out_dir}} --model {{model}}

# Manual PR summary workflow using a cloned repo plus containerized opencode run
opencode-lab-pr-summary-run repo_url base_ref head_ref out_dir model="openai/gpt-5.4":
    bun experiments/opencode-lab/src/pr-summary-manual.ts --repo-url {{repo_url}} --base-ref {{base_ref}} --head-ref {{head_ref}} --out-dir {{out_dir}} --model {{model}} --driver run

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
