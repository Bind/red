---
name: craft-release
description: Cut a production release for red and verify it is healthy in production. Use when the user wants to tag and publish a release, monitor the GitHub Release workflow, confirm `red.computer` is healthy after deploy, or reason about rollback for a bad production release.
---

# Craft Release

Use this skill for the red production release path.

This skill is the repo-local equivalent of a `land-and-deploy` workflow:

- prepare the release
- monitor the automatic GitHub Release publication
- monitor the release workflow
- verify production health
- summarize rollback options if deploy health fails

## Read first

1. Read [references/release-playbook.md](references/release-playbook.md).
2. Treat [docs/release.md](../../docs/release.md) and [.github/workflows/release.yml](../../.github/workflows/release.yml) as the source of truth.
3. Use shared lifecycle entrypoints from `just` instead of inventing bespoke commands.

## Modes

### Dry run

Use this before doing anything irreversible, or on first use in a session.

1. Confirm the target branch/commit/tag the user intends to release.
2. Validate release prerequisites:
- `gh auth status`
- `just ci::secrets-check .env.ci production`
- repo state is sane enough for tagging or publishing
3. Show the exact GitHub actions that will happen next after merge to `main`.
4. Stop before merging or manually publishing any release unless the user explicitly wants the real release.

### Real release

1. Make sure the user explicitly wants production release execution now.
2. Ensure the intended commit is on `main`, because merges to `main` auto-publish the next patch release.
3. Monitor the GitHub Actions `Build app images` workflow until it publishes the release.
4. Then monitor the GitHub Actions `Release` workflow until it finishes:
- image build
- provision
- deploy
- post-deploy health check
5. If the workflow succeeds, run a direct production verification with `just deploy-check https://red.computer`.
6. Report final status as one of:
- released and verified
- released but verification failed
- release workflow failed before deploy completed

## Failure handling

When the workflow fails:

1. Identify the exact failing job and step.
2. Tie the failure back to the repo surface:
- `.env.ci` / `ci.just`
- `sst.config.ts`
- `infra/prod/deploy.sh`
- `docs/release.md`
3. Do not claim prod is healthy unless both the workflow and live health check pass.
4. If rollback is needed, use the repo's documented rollback path from [references/release-playbook.md](references/release-playbook.md).

## Guardrails

- Prefer `gh` for GitHub release and workflow operations.
- Prefer `just` entrypoints for repo actions.
- Do not invent a manual deploy path unless the documented release path is already broken and the user wants recovery work.
- Be explicit about whether you are in dry-run mode or real-release mode.
- Use concrete run URLs, job URLs, tag names, and dates in status updates.
