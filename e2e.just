# End-to-end testing

set dotenv-load

FORGEJO_ADMIN := "redc-admin"
FORGEJO_PASS := "admin1234"
REDC_PORT := env("REDC_PORT", "3002")
TEST_REPO := "test-repo"

# Push a test commit to trigger the full pipeline
push:
    #!/usr/bin/env bash
    set -euo pipefail
    CLONE_DIR=$(mktemp -d)
    echo "Cloning test repo to $CLONE_DIR..."
    git clone "http://{{ FORGEJO_ADMIN }}:{{ FORGEJO_PASS }}@localhost:3001/{{ FORGEJO_ADMIN }}/{{ TEST_REPO }}.git" "$CLONE_DIR"
    cd "$CLONE_DIR"
    BRANCH="test-$(date +%s)"
    git checkout -b "$BRANCH"
    echo "change at $(date)" > test-file.txt
    git add .
    git commit -m "test change from just e2e push"
    git push origin "$BRANCH"
    echo ""
    echo "Pushed branch: $BRANCH"
    echo "Check: just e2e ping"
    rm -rf "$CLONE_DIR"

# Check redc health and show current state
ping:
    @echo "Health:"
    @curl -sf localhost:{{ REDC_PORT }}/health | jq .
    @echo ""
    @echo "Velocity (24h):"
    @curl -sf localhost:{{ REDC_PORT }}/api/velocity | jq .
    @echo ""
    @echo "Review queue:"
    @curl -sf localhost:{{ REDC_PORT }}/api/review | jq .
    @echo ""
    @echo "Pending jobs:"
    @curl -sf localhost:{{ REDC_PORT }}/api/jobs/pending | jq .

# Show a specific change by ID
change id:
    @curl -sf localhost:{{ REDC_PORT }}/api/changes/{{ id }} | jq .
