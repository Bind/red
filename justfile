# redc — agent-native code forge

set dotenv-load

mod infra

DEV_COMPOSE := "infra/compose/dev.yml"

# Default: show available commands
default:
    @just --list --unsorted

# One-time local bootstrap: env, runner image, and dev services
setup:
    ./infra/scripts/setup-dev-env.sh

# Start all local services in Docker without forcing rebuilds
up:
    SKIP_IMAGE_BUILD=true ./infra/scripts/setup-dev-env.sh

# Rebuild Docker images, then start the full stack
up-build:
    ./infra/scripts/setup-dev-env.sh

# Stop all local services
down:
    just infra down

# Rebuild app containers and the OpenCode runner image
build:
    docker compose -f {{ DEV_COMPOSE }} build
    docker build -t redc-claw-runner apps/ocr/

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
    docker compose -f {{ DEV_COMPOSE }} exec ctl bun test

# Run type checking inside Docker
typecheck:
    docker compose -f {{ DEV_COMPOSE }} exec ctl bunx tsc --noEmit

# Run repository formatters
fmt:
    just auth-format
    just git-mirror-canary-format

# Run repository linters
lint:
    just auth-lint
    just git-mirror-canary-lint

# Build the production frontend bundle inside Docker
web-build:
    docker compose -f {{ DEV_COMPOSE }} exec web bun run build

# Full local verification
verify: lint typecheck test

# Install repo git hooks
hooks-install:
    ./scripts/install-githooks.sh

# Run tests for the git server package
git-server-test:
    cd apps/grs && bun test

# Run Zig format/build/test checks for the native git server
git-server-zig-check:
    #!/usr/bin/env bash
    set -euo pipefail
    zig_bin="${ZIG_BIN:-}"
    if [ -z "$zig_bin" ]; then
        if command -v zig >/dev/null 2>&1; then
            zig_bin="$(command -v zig)"
        elif [ -x "$HOME/.local/zig/current/zig" ]; then
            zig_bin="$HOME/.local/zig/current/zig"
        else
            echo "Skipping apps/grs/zig checks: local zig is not installed."
            exit 0
        fi
    fi
    zig_version="$("$zig_bin" version)"
    case "$zig_version" in
        0.16.*|0.16.0-dev.*) ;;
        *)
            echo "Skipping apps/grs/zig checks: local zig $zig_version is incompatible with apps/grs/zig (requires 0.16.x)."
            exit 0
            ;;
    esac
    cd apps/grs/zig
    find src -name '*.zig' -print | xargs "$zig_bin" fmt build.zig
    "$zig_bin" build test
    "$zig_bin" build server-only -Doptimize=ReleaseFast

# Run the full native Zig git-server integration suite
gs-integration:
    docker compose -f {{ DEV_COMPOSE }} build grs
    cd apps/grs && bun test ./src/tests/*.integration.ts

# Start git server dependencies and service from the root compose stack
git-server-up:
    docker compose -f {{ DEV_COMPOSE }} up --build grs s3 init

# Stop the git server service from the root compose stack
git-server-down:
    docker compose -f {{ DEV_COMPOSE }} rm -sf grs init

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

# ── CLI ─────────────────────────────────────────────────

# Show merge velocity and review queue
status:
    docker compose -f {{ DEV_COMPOSE }} exec ctl bun run apps/ctl/cli/index.ts status

# Browse known repos with fzf
repos:
    @docker compose -f {{ DEV_COMPOSE }} exec -T ctl bun run apps/ctl/cli/index.ts status --format json \
        | bun -e 'const input=await Bun.stdin.json(); const rows=Object.entries(input.by_repo ?? {}); for (const [name, count] of rows) console.log(`${name}\t${count}`)' \
        | fzf --delimiter='\t' --with-nth=1 --preview='echo "Queued changes: {2}"' \
        | cut -f1

# Install dependencies for the git mirror canary experiment
git-mirror-canary-install:
    cd experiments/git-mirror-canary && bun install

# Start the git mirror canary experiment locally
git-mirror-canary-serve:
    cd experiments/git-mirror-canary && bun run src/index.ts

# Run tests for the git mirror canary experiment
git-mirror-canary-test:
    cd experiments/git-mirror-canary && bun test

# Lint the git mirror canary experiment
git-mirror-canary-lint:
    cd experiments/git-mirror-canary && bun run lint

# Format the git mirror canary experiment
git-mirror-canary-format:
    cd experiments/git-mirror-canary && bun run format

# Bring up the git mirror canary compose stack
git-mirror-canary-compose-up:
    docker compose -f experiments/git-mirror-canary/docker-compose.yml up --build -d
    until curl -fsS http://127.0.0.1:$${GIT_MIRROR_CANARY_PUBLISHED_PORT:-4080}/health >/dev/null; do sleep 1; done

# Tear down the git mirror canary compose stack
git-mirror-canary-compose-down:
    docker compose -f experiments/git-mirror-canary/docker-compose.yml down -v --remove-orphans

# Run compose E2E for the git mirror canary experiment
git-mirror-canary-compose-e2e:
    cd experiments/git-mirror-canary && ./compose/e2e.sh

# ── Triage ──────────────────────────────────────────────

# Start the triage service (stub workflow) alongside the dev stack
triage-up:
    docker compose -f {{ DEV_COMPOSE }} --profile triage up -d triage

# Tear down the triage service
triage-down:
    docker compose -f {{ DEV_COMPOSE }} rm -sf triage

# Tail triage logs
triage-logs:
    docker compose -f {{ DEV_COMPOSE }} logs -f triage

# Run triage tests
triage-test:
    cd apps/triage && bun test

# Demo: POST the failing star endpoint and list triage runs it created
triage-demo owner="redc" repo="demo":
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> POST /api/repos/{{ owner }}/{{ repo }}/star (expect 500)"
    curl -sS -o /dev/null -w "status=%{http_code}\n" \
        -X POST http://localhost:3000/api/repos/{{ owner }}/{{ repo }}/star
    echo "==> giving obs a moment to flush..."
    sleep 3
    echo "==> triage runs:"
    curl -sS http://localhost:7000/v1/runs | bun -e 'const d=await Bun.stdin.json(); for (const r of d.runs ?? []) console.log(`${r.id.slice(0,8)}  ${r.status.padEnd(16)} ${r.rollup.entry_service} ${r.rollup.route_names?.[0] ?? ""}`)'

# ── Obs ─────────────────────────────────────────────────

# Install dependencies for the obs app
obs-install:
    cd apps/obs && bun install

# Start the obs app locally
obs-serve:
    cd apps/obs && bun run src/index.ts

# Replay recent raw events into rollups for the obs app
obs-replay:
    cd apps/obs && bun run src/replay.ts

# Run tests for the obs app
obs-test:
    cd apps/obs && bun test

# Typecheck the obs app
obs-typecheck:
    cd apps/obs && bun run typecheck

# Lint the obs app
obs-lint:
    cd apps/obs && bun run lint

# Format the obs app
obs-format:
    cd apps/obs && bun run format
