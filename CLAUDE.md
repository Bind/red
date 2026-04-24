# redc

use the `justfile` as command runner. Run `./scripts/redc` to see available CLI commands.

## Integration tests

For git-server live integration coverage, use the `.integration.ts` suffix so those tests stay out of the default `bun test` run.

Run the full native git-server integration suite with `just gs-integration`.

## Git hooks

Install repo hooks with `just hooks-install`.

The repo uses `.githooks/pre-commit` for fast local checks only. Keep the heavier git-server integration suite in `just gs-integration` for explicit runs and eventual CI/CD.

When `apps/grs/zig/` is staged, pre-commit also runs the native Zig format/build/test checks via `just git-server-zig-check`.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Keep repo-owned skill definitions under `.agents/skills/`. Do not add or duplicate
repo skill definitions under `.codex/`.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Preview deploy debugging, preview URL failures, remote preview SSH/log inspection → invoke debug-preview
- Obs request tracing, MinIO rollup/raw debugging → invoke wide-events-observability
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
