# CI Runner Lab

Experiment for a trusted-internal CI job runner MVP.

The direction has narrowed from the initial step-array prototype to a simpler
Bash-first model:

- one job primitive: `scripts/ci/<job>.sh`
- immutable `repo_id + commit_sha + job_name` job spec
- append-only attempts for retries
- disposable mutable workspace inside a runner-owned container
- SQLite metadata plus MinIO-backed logs and artifacts

The current MVP design is documented in [docs/mvp-design.md](./docs/mvp-design.md).

This is not a secure multi-tenant sandbox and not a GitHub Actions replacement.
Untrusted execution will require a separate design pass.

## Run

```bash
cd experiments/ci-runner-lab
just install
just serve
```

Submit a job:

```bash
curl -fsS http://127.0.0.1:4091/jobs \
  -H 'content-type: application/json' \
  -d '{
    "repoId": "red/example",
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "jobName": "test",
    "env": {
      "JOB_SAMPLE": "local"
    },
    "gitCredentialGrant": "grant-1"
  }'
```

## Compose

```bash
cd experiments/ci-runner-lab
export CI_RUNNER_LAB_HOST_DATA_DIR="$PWD/.data"
export CI_RUNNER_LAB_MAX_CONCURRENT_RUNS=2
export CI_RUNNER_LAB_STEP_TIMEOUT_MS=15000
just compose-up
```

## Verify

```bash
cd experiments/ci-runner-lab
just test
just typecheck
just compose-e2e
```
