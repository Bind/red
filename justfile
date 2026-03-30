# redc — agent-native code forge

set dotenv-load

mod infra
mod e2e

# Default: show available commands
default:
    @just --list --unsorted

# ── First-time setup ───────────────────────────────────

FORGEJO_URL := env("FORGEJO_URL", "http://localhost:3001")
FORGEJO_ADMIN := "redc-admin"
FORGEJO_PASS := "admin1234"
WEBHOOK_SECRET := env("WEBHOOK_SECRET", "dev-secret-123")
REDC_PORT := env("REDC_PORT", "3000")
TEST_REPO := "test-repo"

# One-time setup: Forgejo + admin + repo + webhook + .env
setup:
    #!/usr/bin/env bash
    set -euo pipefail

    just infra up

    echo "Creating admin user..."
    docker compose exec -T forgejo su -c \
        'forgejo admin user create --username "{{ FORGEJO_ADMIN }}" --password "{{ FORGEJO_PASS }}" --email "admin@redc.local" --admin --must-change-password=false' \
        git 2>/dev/null \
        || echo "  (user may already exist)"

    echo "Creating API token..."
    TOKEN_RESPONSE=$(curl -sf -X POST "{{ FORGEJO_URL }}/api/v1/users/{{ FORGEJO_ADMIN }}/tokens" \
        -u "{{ FORGEJO_ADMIN }}:{{ FORGEJO_PASS }}" \
        -H "Content-Type: application/json" \
        -d '{"name":"redc-dev-'"$(date +%s)"'","scopes":["all"]}')

    FORGEJO_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"sha1":"[^"]*"' | cut -d'"' -f4)
    if [ -z "$FORGEJO_TOKEN" ]; then
        echo "ERROR: Failed to create token. Response: $TOKEN_RESPONSE"
        exit 1
    fi
    echo "  Token: ${FORGEJO_TOKEN:0:8}..."

    echo "Creating test repo..."
    curl -sf -X POST "{{ FORGEJO_URL }}/api/v1/user/repos" \
        -H "Authorization: token $FORGEJO_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"name":"{{ TEST_REPO }}","auto_init":true,"default_branch":"main"}' > /dev/null 2>&1 \
        || echo "  (repo may already exist)"

    echo "Creating webhook..."
    curl -sf -X POST "{{ FORGEJO_URL }}/api/v1/repos/{{ FORGEJO_ADMIN }}/{{ TEST_REPO }}/hooks" \
        -H "Authorization: token $FORGEJO_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
            "type": "forgejo",
            "active": true,
            "config": {
                "url": "http://host.docker.internal:{{ REDC_PORT }}/webhook/push",
                "content_type": "json",
                "secret": "{{ WEBHOOK_SECRET }}"
            },
            "events": ["push"]
        }' > /dev/null 2>&1 \
        || echo "  (webhook may already exist)"

    echo "Writing .env..."
    cat > .env <<EOF
    FORGEJO_URL={{ FORGEJO_URL }}
    FORGEJO_TOKEN=$FORGEJO_TOKEN
    WEBHOOK_SECRET={{ WEBHOOK_SECRET }}
    REDC_PORT={{ REDC_PORT }}
    REDC_DB_PATH=redc-dev.db
    EOF
    sed -i '' 's/^    //' .env

    echo ""
    echo "=== Setup complete ==="
    echo "Run: just dev"

# ── Development ─────────────────────────────────────────

# Start redc API server (hot-reload)
dev:
    bun run --watch src/index.ts

# Start Vite dev server for frontend
web:
    cd web && bun run dev

# Build frontend for production
web-build:
    cd web && bun run build

# Start redc API server
start:
    bun run src/index.ts

# Run all tests
test:
    bun test

# Type check
check:
    bunx tsc --noEmit

# Type check + tests
ci: check test

# ── CLI ─────────────────────────────────────────────────

# Bootstrap Forgejo user, repo, and git remote from GitHub identity
bootstrap:
    bun run src/cli/index.ts bootstrap

# Show merge velocity and review queue
status:
    bun run src/cli/index.ts status

# Browse all Forgejo repos with fzf
repos:
    @curl -sf "{{ FORGEJO_URL }}/api/v1/admin/repos?limit=50&token=$FORGEJO_TOKEN" \
        | bun -e 'const repos=await Bun.stdin.json();for(const r of repos)console.log(r.full_name+"\t"+r.html_url+"\t"+(r.description||""))' \
        | fzf --delimiter='\t' --with-nth=1 --preview='echo "URL: {2}\nDesc: {3}"' \
        | cut -f2

# Dry-run policy evaluation
policy-test path=".redc/policy.yaml":
    bun run src/cli/index.ts policy test {{ path }}
