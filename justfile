# red — agent-native code forge

set dotenv-load

mod infra

DEV_COMPOSE := "infra/dev/compose.yml"
BASE_COMPOSE := "infra/base/compose.yml"
PREVIEW_COMPOSE := "infra/preview/compose.yml"
PROD_COMPOSE := "infra/prod/compose.yml"

# Default: show available commands
default:
    @just --list --unsorted

# One-time local bootstrap: env, runner image, and dev services
setup:
    bun install --frozen-lockfile
    ./infra/dev/run.sh

# Start the local stack with hot-reload mounts and reuse existing images by default
up:
    bun install --frozen-lockfile
    SKIP_IMAGE_BUILD=true ./infra/dev/run.sh

# Back-compat alias for the fast dev path
up-fast:
    just up

# Explicitly rebuild local images before starting the stack
up-build:
    bun install --frozen-lockfile
    ./infra/dev/run.sh

# Stop all local services
down:
    just infra down

# Rebuild app containers and the OpenCode runner image
build:
    just workspace-deps-build-local
    docker compose -f {{ DEV_COMPOSE }} build
    docker build -t red-claw-runner apps/ocr/

# Prebuild local workspace dependency layers shared by Dockerfiles
workspace-deps-build-local:
    docker build \
        -f infra/base/Dockerfile.workspace-deps \
        --build-arg BUN_IMAGE=oven/bun:1-alpine \
        -t red-workspace-deps-alpine:dev \
        .

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

# Run repository linters
lint:
    just auth-lint

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

# Build a new red-base snapshot on Hetzner. Requires HCLOUD_TOKEN
# (pulled from .env.ci via dotenvx). Prints the snapshot id/name at the
# end of the packer run; set it as RED_BASE_SNAPSHOT_ID for future
# `sst deploy`.
image-build:
    dotenvx run -f .env.ci -- packer init infra/platform/packer
    dotenvx run -f .env.ci -- packer build infra/platform/packer

# List all red-base snapshots currently in the account.
image-list:
    @dotenvx run -f .env.ci -- bash -c \
      'curl -fsSL -H "Authorization: Bearer $HCLOUD_TOKEN" \
         "https://api.hetzner.cloud/v1/images?type=snapshot&label_selector=role=red-base" \
       | jq ".images[] | {id, description, created}"'

# ── Release / deploy ────────────────────────────────────

# Provision / update infra via SST and sync any exported env vars into local files.
provision stage="production" *targets:
    bunx sst deploy --stage {{ stage }}
    ./infra/platform/sync-sst-env.sh {{ targets }}

# Bootstrap the preview/dev box over SSH using credentials from .env.ci/.env.keys.
bootstrap-dev-box host port="2222":
    ./infra/preview/setup.sh {{ host }} {{ port }}

# Rsync working tree to the host and pull/start the runtime + prod overlay over ssh
deploy-ssh image_tag git_commit host="red.computer" port="2222":
    ./infra/prod/deploy.sh {{ host }} {{ port }} {{ image_tag }} {{ git_commit }}

# Curl the post-deploy health endpoint and fail unless status=="ok"
deploy-check url="https://red.computer":
    #!/usr/bin/env bash
    set -euo pipefail
    body="$(curl -fsSL --retry 12 --retry-delay 5 --retry-all-errors --max-time 15 {{ url }}/health)"
    echo "$body" | jq .
    status="$(echo "$body" | jq -r .status)"
    if [ "$status" != "ok" ]; then
      echo "health status is $status"
      exit 1
    fi

# Deploy a per-PR preview (slug like pr-42) to the dev box
deploy-preview slug host image_tag git_commit base_branch base_ref head_branch pr_number port="2222":
    ./infra/preview/deploy.sh {{ slug }} {{ host }} {{ port }} {{ image_tag }} {{ git_commit }} {{ base_branch }} {{ base_ref }} {{ head_branch }} {{ pr_number }}

# Tear down a per-PR preview
teardown-preview slug host port="2222":
    ./infra/preview/teardown.sh {{ slug }} {{ host }} {{ port }}

# Remove preview stacks whose PRs are no longer open
preview-gc host port="2222":
    ./infra/preview/garbage-collect.sh {{ host }} {{ port }}

# Smoke-check a deployed preview URL
preview-check slug:
    just deploy-check "https://{{ slug }}.preview.red.computer"
