# red

use the `justfile` as command runner. Run `./scripts/red` to see available CLI commands.

Prefer extending the existing lifecycle entrypoints in `justfile` over adding
new bespoke workflow commands or one-off automation paths. Keep the repo's full
lifecycle surface stable around the shared `just` methods (`provision`,
`run`/local dev, `deploy-*`, `teardown-*`) so humans and agents use the same
entrypoints.

## Integration tests

For git-server live integration coverage, use the `.integration.ts` suffix so those tests stay out of the default `bun test` run.

Run the full native git-server integration suite with `just gs-integration`.

## Git hooks

Install repo hooks with `just hooks-install`.

The repo uses `.githooks/pre-commit` for fast local checks only. Keep the heavier git-server integration suite in `just gs-integration` for explicit runs and eventual CI/CD.

When `apps/grs/zig/` is staged, pre-commit also runs the native Zig format/build/test checks via `just git-server-zig-check`.

## Git checkout policy

Use `/Users/db/workspace/redc` as the single working checkout for this repo.
When working on a different branch or PR, switch branches in this folder instead
of creating a new Git worktree, unless the user explicitly asks for a separate
worktree.
