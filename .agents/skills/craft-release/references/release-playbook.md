# Release Playbook

This file captures the red-specific production release flow that the skill should follow.

## Source of truth

- [docs/release.md](../../../docs/release.md)
- [.github/workflows/release.yml](../../../.github/workflows/release.yml)
- [ci.just](../../../ci.just)
- [justfile](../../../justfile)

## Production release model

Production deploy is triggered by publishing a GitHub Release.

Tag push alone is not enough.

Typical operator sequence:

```bash
git checkout main
git pull
git tag -a vX.Y.Z -m "release vX.Y.Z"
git push origin vX.Y.Z
```

Then publish the GitHub Release on GitHub, or use `gh release create` if the user wants CLI execution.

## Workflow behavior

The `Release` workflow does this:

1. Resolve the release tag to a commit SHA on `main`.
2. Assert the canonical images for that commit SHA already exist in GHCR:

```bash
just ci::assert-release-images <commit-sha>
```

3. Retag those existing images with the human-friendly release tag:

```bash
just ci::retag-release-images <commit-sha> <release-tag>
```

4. Validate CI secrets with:

```bash
just ci::secrets-check .env.ci production
```

5. Provision infra:

```bash
dotenvx run -f .env.ci -- just provision production .env.ci
```

6. Configure the SSH key from `.env.ci`.
7. Deploy code:

```bash
just deploy-ssh <release-tag> <commit-sha> red.computer 2222
```

8. Verify deploy health:

```bash
just deploy-check https://red.computer
```

## Monitoring commands

Use GitHub CLI when possible.

Examples:

```bash
gh release view <tag>
gh run list --workflow Release --limit 5
gh run watch <run-id>
gh run view <run-id>
gh run view <run-id> --job <job-id> --log
```

If the user gives a run URL or job URL, inspect that exact run first.

## Healthy release criteria

Do not say production is healthy unless all of these are true:

1. The GitHub `Release` workflow completed successfully.
2. The `provision + deploy + health check` job succeeded.
3. A direct live health verification succeeds:

```bash
just deploy-check https://red.computer
```

## Common failure buckets

- Missing or broken `.env.ci` secrets
- Missing prebuilt GHCR images for the tagged commit SHA
- SST provision failure in `just provision production`
- SSH key / host auth issues during `deploy-ssh`
- Docker compose startup failure on the host
- Live `/health` check returning non-`ok`

## Rollback

Rollback is not automated.

Documented manual path:

```bash
git checkout <good-sha>
just deploy-ssh <release-tag> <good-sha> red.computer 2222
```

Or publish a new release tag pointing at the last known-good SHA if the user wants to re-run the standard release path.
