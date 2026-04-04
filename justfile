# redc — agent-native code forge

set dotenv-load

mod infra
mod e2e

DEV_COMPOSE := "infra/compose/dev.yml"

# Default: show available commands
default:
    @just --list --unsorted

# Local stack configuration
FORGEJO_URL := env("FORGEJO_URL", "http://localhost:3001")
REDC_PORT := env("REDC_PORT", "3002")
WEB_PORT := "5173"

# One-time local bootstrap: Forgejo admin, token, repo, webhook, and app env
setup:
    ./infra/scripts/setup-dev-env.sh

# Start all local services in Docker, bootstrapping first if needed
up:
    ./infra/scripts/setup-dev-env.sh

# Stop all local services
down:
    just infra down

# Rebuild app containers and the Claw runner image
build:
    docker compose -f {{ DEV_COMPOSE }} build
    docker build -t redc-claw-runner tools/claw-runner/

# Show local service status
ps:
    docker compose -f {{ DEV_COMPOSE }} ps

# Tail logs for one service, or pick one with fzf if omitted
logs service="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ service }}" ]; then
        docker compose -f {{ DEV_COMPOSE }} logs -f {{ service }}
    else
        selected_service="$(
            docker compose -f {{ DEV_COMPOSE }} config --services | fzf --prompt='service> ' --height=40% --reverse
        )"
        [ -n "$selected_service" ] || exit 0
        docker compose -f {{ DEV_COMPOSE }} logs -f "$selected_service"
    fi

# Open a shell inside a running service, or pick one with fzf
shell service="":
    #!/usr/bin/env bash
    set -euo pipefail
    selected_service="{{ service }}"
    if [ -z "$selected_service" ]; then
        selected_service="$(
            docker compose -f {{ DEV_COMPOSE }} config --services | fzf --prompt='service> ' --height=40% --reverse
        )"
    fi
    [ -n "$selected_service" ] || exit 0
    docker compose -f {{ DEV_COMPOSE }} exec "$selected_service" sh

# Run a command inside a running service, or pick one with fzf
exec service="" *cmd:
    #!/usr/bin/env bash
    set -euo pipefail
    selected_service="{{ service }}"
    if [ -z "$selected_service" ]; then
        selected_service="$(
            docker compose -f {{ DEV_COMPOSE }} config --services | fzf --prompt='service> ' --height=40% --reverse
        )"
    fi
    [ -n "$selected_service" ] || exit 0
    docker compose -f {{ DEV_COMPOSE }} exec "$selected_service" {{ cmd }}

# Run backend tests inside Docker
test:
    docker compose -f {{ DEV_COMPOSE }} exec api bun test

# Run type checking inside Docker
typecheck:
    docker compose -f {{ DEV_COMPOSE }} exec api bunx tsc --noEmit

# Build the production frontend bundle inside Docker
web-build:
    docker compose -f {{ DEV_COMPOSE }} exec web bun run build

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
    cd apps/git-server && bun src/manual/cli.ts {{args}}

# Run tests for the git server package
git-server-test:
    cd apps/git-server && bun test

# Run the live git-backed integration harness
git-server-integration:
    cd apps/git-server && bun src/manual/cli.ts integration

# Run the live git-backed integration test
git-server-integration-test:
    cd apps/git-server && GIT_SERVER_RUN_INTEGRATION=1 bun test src/tests/integration.test.ts
    cd apps/git-server && GIT_SERVER_RUN_INTEGRATION=1 bun test src/tests/auth-integration.test.ts

# Start git server dependencies and service from the root compose stack
git-server-up:
    docker compose -f {{ DEV_COMPOSE }} up --build git-server minio minio-init

# Stop the git server service from the root compose stack
git-server-down:
    docker compose -f {{ DEV_COMPOSE }} rm -sf git-server minio-init

# Install dependencies for the isolated OpenCode spike
opencode-lab-install:
    cd experiments/opencode-lab && bun install

# Install dependencies for the JWKS auth experiment
jwks-auth-lab-install:
    cd experiments/jwks-auth-lab && bun install

# Start the JWKS auth experiment server
jwks-auth-lab-serve:
    cd experiments/jwks-auth-lab && bun run src/index.ts

# Run tests for the JWKS auth experiment
jwks-auth-lab-test:
    cd experiments/jwks-auth-lab && bun test

# Install dependencies for the auth service
auth-install:
    cd apps/auth && bun install

# Start the auth service
auth-serve:
    cd apps/auth && bun run src/index.ts

# Run tests for the auth service
auth-test:
    cd apps/auth && bun test

# Lint the auth service with Biome
auth-lint:
    cd apps/auth && bun run lint

# Format the auth service with Biome
auth-format:
    cd apps/auth && bun run format

# Generate the local-only auth compose signing key if needed
auth-compose-keygen:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p apps/auth/compose
    if [[ -f apps/auth/compose/signing-key.private.jwk ]]; then
        exit 0
    fi
    cd apps/auth && bun --eval 'import { writeFileSync } from "node:fs"; import { generateKeyPairSync } from "node:crypto"; import { exportJWK } from "jose"; const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); const jwk = await exportJWK(privateKey); writeFileSync("compose/signing-key.private.jwk", `${JSON.stringify(jwk, null, 2)}\n`);'

# Bring up the auth compose stack
auth-compose-up:
    just auth-compose-keygen
    docker compose -f apps/auth/docker-compose.yml up --build -d auth-db auth
    until curl -fsS http://127.0.0.1:4020/health >/dev/null; do sleep 1; done

# Tear down the auth compose stack
auth-compose-down:
    docker compose -f apps/auth/docker-compose.yml down -v --remove-orphans

# Run auth E2E tests against the compose stack
auth-compose-e2e:
    #!/usr/bin/env bash
    set -euo pipefail
    repo_root="$(pwd)"
    compose_file="$repo_root/apps/auth/docker-compose.yml"
    just auth-compose-keygen
    docker compose -f "$compose_file" up --build -d auth-db auth
    cleanup() {
        docker compose -f "$compose_file" down -v --remove-orphans
    }
    trap cleanup EXIT
    until curl -fsS http://127.0.0.1:4020/health >/dev/null; do sleep 1; done
    cd apps/auth && \
        AUTH_LAB_E2E_BASE_URL=http://127.0.0.1:4020 \
        AUTH_LAB_E2E_DB_URL=postgres://auth_lab:auth_lab_password@127.0.0.1:5433/auth_lab \
        AUTH_LAB_E2E_COMPOSE_FILE=./docker-compose.yml \
        AUTH_LAB_BETTER_AUTH_SECRET=auth-lab-compose-secret \
        bun test src/test/compose-e2e.test.ts

# Backwards-compatible aliases for the old experiment name
auth-lab-install: auth-install
auth-lab-serve: auth-serve
auth-lab-test: auth-test
auth-lab-lint: auth-lint
auth-lab-format: auth-format
auth-lab-compose-keygen: auth-compose-keygen
auth-lab-compose-up: auth-compose-up
auth-lab-compose-down: auth-compose-down
auth-lab-compose-e2e: auth-compose-e2e

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
    docker compose -f {{ DEV_COMPOSE }} exec api bun run apps/api/cli/index.ts bootstrap

# Show merge velocity and review queue
status:
    docker compose -f {{ DEV_COMPOSE }} exec api bun run apps/api/cli/index.ts status

# Browse all Forgejo repos with fzf
repos:
    @curl -sf "{{ FORGEJO_URL }}/api/v1/admin/repos?limit=50&token=$FORGEJO_TOKEN" \
        | bun -e 'const repos=await Bun.stdin.json();for(const r of repos)console.log(r.full_name+"\t"+r.html_url+"\t"+(r.description||""))' \
        | fzf --delimiter='\t' --with-nth=1 --preview='echo "URL: {2}\nDesc: {3}"' \
        | cut -f2

# Dry-run policy evaluation
policy-test path=".redc/policy.yaml":
    docker compose -f {{ DEV_COMPOSE }} exec api bun run apps/api/cli/index.ts policy test {{ path }}
