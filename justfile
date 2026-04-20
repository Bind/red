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
exec *args:
    #!/usr/bin/env bash
    set -euo pipefail
    service="${1:-}"
    if [ $# -gt 0 ]; then shift; fi
    if [ -z "$service" ]; then
        service="$(
            docker compose -f {{ DEV_COMPOSE }} config --services \
              | fzf --prompt='service> ' --height=40% --reverse
        )"
    fi
    [ -n "$service" ] || exit 0
    docker compose -f {{ DEV_COMPOSE }} exec "$service" "$@"

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

# Start the triage service and its Smithers server alongside the dev stack
triage-up:
    docker compose -f {{ DEV_COMPOSE }} --profile triage up -d triage-smithers triage

# Tear down the triage service + smithers server
triage-down:
    docker compose -f {{ DEV_COMPOSE }} rm -sf triage triage-smithers

# Tail triage logs (pass service=smithers for the smithers server)
triage-logs service="triage":
    docker compose -f {{ DEV_COMPOSE }} logs -f {{ if service == "smithers" { "triage-smithers" } else { "triage" } }}

# Run triage tests
triage-test:
    cd apps/triage && bun test

# Restart triage in real-smithers mode (requires ANTHROPIC_API_KEY in .env)
triage-smithers-mode:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! grep -q '^ANTHROPIC_API_KEY=..' .env 2>/dev/null; then
        echo "error: set ANTHROPIC_API_KEY in .env before enabling smithers mode" >&2
        exit 1
    fi
    TRIAGE_WORKFLOW_MODE=smithers docker compose -f {{ DEV_COMPOSE }} --profile triage up -d --force-recreate triage-smithers triage
    echo "triage now running in smithers mode"

# Switch triage back to the stub workflow runner (smithers server stays running)
triage-stub-mode:
    TRIAGE_WORKFLOW_MODE=stub docker compose -f {{ DEV_COMPOSE }} --profile triage up -d --force-recreate triage

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

# ── Secrets (dotenvx) ───────────────────────────────────

# Encrypt .env.<env> in place, appending the private key to .env.keys.
# Usage: just secrets-encrypt production
secrets-encrypt env:
    dotenvx encrypt -f .env.{{ env }}

# Decrypt .env.<env> to stdout (or -o <path>). Handy for inspecting values.
# Usage: just secrets-show production
secrets-show env:
    dotenvx decrypt -f .env.{{ env }} --stdout

# Edit .env.<env> interactively (decrypts → $EDITOR → re-encrypts).
secrets-edit env:
    dotenvx edit -f .env.{{ env }}

# Pretty-print the keys currently defined in .env.<env> without revealing values.
secrets-keys env:
    dotenvx keys -f .env.{{ env }}

# ── Base image (packer / hcloud snapshot) ───────────────

# Build a new redc-base snapshot on Hetzner. Requires HCLOUD_TOKEN
# (pulled from .env.ci via dotenvx). Prints the snapshot id/name at the
# end of the packer run; set it as REDC_BASE_SNAPSHOT_ID for future
# `sst deploy`.
image-build:
    dotenvx run -f .env.ci -- packer init infra/packer
    dotenvx run -f .env.ci -- packer build infra/packer

# List all redc-base snapshots currently in the account.
image-list:
    @dotenvx run -f .env.ci -- bash -c \
      'curl -fsSL -H "Authorization: Bearer $HCLOUD_TOKEN" \
         "https://api.hetzner.cloud/v1/images?type=snapshot&label_selector=role=redc-base" \
       | jq ".images[] | {id, description, created}"'

# ── Release / deploy ────────────────────────────────────

# Provision / update infra via SST; requires HCLOUD_TOKEN, CLOUDFLARE_API_TOKEN, etc.
deploy-infra stage="production":
    bunx sst deploy --stage {{ stage }}

# Bootstrap the preview/dev box over SSH using credentials from .env.ci/.env.keys.
bootstrap-dev-box host port="22":
    ./infra/scripts/bootstrap-dev-box.sh {{ host }} {{ port }}

# Rsync working tree to the host and bring up infra/compose/prod.yml over ssh
deploy-ssh host="red.computer" port="2222":
    ./infra/scripts/deploy.sh {{ host }} {{ port }}

# Curl the post-deploy health endpoint and fail unless status=="ok"
deploy-check url="https://red.computer":
    #!/usr/bin/env bash
    set -euo pipefail
    body="$(curl -fsSL --retry 5 --retry-delay 5 --max-time 15 {{ url }}/health)"
    echo "$body" | jq .
    status="$(echo "$body" | jq -r .status)"
    if [ "$status" != "ok" ]; then
      echo "health status is $status"
      exit 1
    fi

# Deploy a per-PR preview (slug like pr-42) to the dev box
deploy-preview slug host port="2222":
    ./infra/scripts/deploy-preview.sh {{ slug }} {{ host }} {{ port }}

# Tear down a per-PR preview
teardown-preview slug host port="2222":
    ./infra/scripts/teardown-preview.sh {{ slug }} {{ host }} {{ port }}

# Smoke-check a deployed preview URL
preview-check slug:
    just deploy-check "https://{{ slug }}.preview.red.computer"

# ── CI ──────────────────────────────────────────────────

# CI setup: bun install, write .env with GIT_COMMIT={{sha}}, and keygen
ci-prep sha:
    bun install --frozen-lockfile
    ./infra/scripts/ci-seed-env.sh {{ sha }}
    just auth-compose-keygen

# Run the in-process health-contract tests (pkg/health unit + per-service)
ci-health-contract sha:
    GIT_COMMIT={{ sha }} bun test \
        pkg/health \
        apps/ctl/health-contract.test.ts \
        apps/obs/src/test/health-contract.test.ts \
        apps/triage/src/health-contract.test.ts

# Bring up the core stack and wait for every healthcheck to pass
ci-health-compose-up:
    docker compose -f {{ DEV_COMPOSE }} --env-file .env \
        up -d --build --wait --wait-timeout 600 \
        s3 init obs grs db-auth auth ctl bff

# Probe each service's /health and assert the {service,status,commit} contract
ci-health-probe:
    #!/usr/bin/env bash
    set -euo pipefail
    declare -A endpoints=(
      [ctl]="http://localhost:3000/health"
      [bff]="http://localhost:3001/health"
      [auth]="http://localhost:4020/health"
      [obs]="http://localhost:4090/health"
      [grs]="http://localhost:9080/health"
    )
    for service in "${!endpoints[@]}"; do
      url="${endpoints[$service]}"
      echo "==> $service $url"
      body=$(curl -fsSL "$url")
      echo "$body" | jq .
      got_service=$(echo "$body" | jq -r .service)
      got_status=$(echo "$body" | jq -r .status)
      got_commit=$(echo "$body" | jq -r .commit)
      [ "$got_service" = "$service" ] || { echo "want service=$service got=$got_service"; exit 1; }
      case "$got_status" in ok|degraded|error) ;; *) echo "bad status=$got_status"; exit 1;; esac
      [ -n "$got_commit" ] && [ "$got_commit" != "null" ] || { echo "missing commit"; exit 1; }
    done
