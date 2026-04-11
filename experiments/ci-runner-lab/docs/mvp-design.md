# CI Runner Lab MVP Design

## Goal

Build a trusted-internal CI job runner MVP for repo-owned Bash jobs without
introducing a workflow DSL.

This is not a secure multi-tenant sandbox and not a GitHub Actions replacement.
It is a first pass at generic runner infrastructure for internal repositories.

## Scope

The MVP supports:

- trusted internal repositories only
- one runner-owned base image, pinned by digest
- one job primitive: run `scripts/ci/<job>.sh` for an immutable commit SHA
- mutable disposable workspace inside the job container
- read-only git access via brokered attempt-scoped credential exchange
- SQLite for job and attempt metadata
- MinIO bucket `ci-runner` for logs and artifacts
- near-real-time log viewing via chunked log ingestion and inline log APIs

The MVP does not support:

- untrusted repository execution
- YAML workflows
- arbitrary command submission
- repo-defined Dockerfiles or per-job images
- git write access
- cancellation
- timeout overrides
- artifact path declarations

## Execution Model

The logical unit is a `job` with append-only `attempts`.

Immutable job spec:

- `repo_id`
- `commit_sha`
- `job_name`
- `env` with `JOB_*` keys only

Attempt-scoped execution input:

- `git_credential_grant`

Execution flow:

1. `POST /jobs` creates a job and `attempt 1`.
2. The scheduler dequeues attempts, not jobs.
3. The runner moves the attempt into `redeeming_credentials`.
4. The runner redeems the opaque grant for short-lived read-only git auth.
5. The runner starts the pinned base image with:
   - a writable disposable workspace
   - a writable artifacts directory
   - read-only mounted git auth helper material
6. Runner-owned bootstrap inside the container:
   - initializes a git checkout
   - fetches the requested commit SHA
   - checks out that exact commit in detached mode
   - verifies `scripts/ci/<job>.sh`
   - executes it from repo root with `bash`
7. The runner collects logs and artifacts, uploads them to MinIO, and records
   final attempt state in SQLite.

## API Shape

Submission:

```json
{
  "repo_id": "org/repo",
  "commit_sha": "0123456789abcdef0123456789abcdef01234567",
  "job_name": "test",
  "env": {
    "JOB_FOO": "bar"
  },
  "git_credential_grant": "opaque-grant"
}
```

Retry:

```json
{
  "git_credential_grant": "new-opaque-grant"
}
```

Initial API surface:

- `POST /jobs`
- `GET /jobs`
- `GET /jobs/:job_id`
- `POST /jobs/:job_id/retry`
- `GET /jobs/:job_id/attempts/:attempt_number/logs?after_seq=N`
- `GET /jobs/:job_id/artifacts`

## Validation Rules

- `repo_id`: canonical forge path, `owner/repo`
- `commit_sha`: full 40-character lowercase hex SHA
- `job_name`: flat slug, resolves to `scripts/ci/<job>.sh`
- submitted env keys must match `JOB_[A-Z0-9_]+`

Submission-time validation only checks schema and syntax.
Repo existence, commit availability, and script existence fail during bootstrap.

## State Model

User-facing state projection:

- `queued`
- `running`
- `success`
- `failed`

Internal lifecycle:

- `queued`
- `redeeming_credentials`
- `starting_container`
- `running`
- `uploading_results`
- `succeeded`
- `failed`

Failure classes:

- `job_failed`
- `bootstrap_failed`
- `image_failed`
- `artifact_upload_failed`
- `system_failed`

## Logs And Artifacts

Logs:

- preserve `stdout` and `stderr` separately
- also produce a merged display stream
- chunk by sequence number
- flush line-buffered when possible, otherwise at time/size thresholds
- expose logs inline through service APIs

Artifacts:

- collected recursively from `$CI_ARTIFACTS_DIR`
- upload regular files only
- reject symlinks and path escapes
- preserve relative paths exactly
- missing artifact dir means no artifacts, not an error
- artifact collection runs on both success and failure

Bucket: `ci-runner`

Object layout:

- `ci/jobs/<job_id>/attempts/<attempt_number>/logs/stdout/chunks/<seq>.txt`
- `ci/jobs/<job_id>/attempts/<attempt_number>/logs/stderr/chunks/<seq>.txt`
- `ci/jobs/<job_id>/attempts/<attempt_number>/logs/display/chunks/<seq>.txt`
- `ci/jobs/<job_id>/attempts/<attempt_number>/logs/final/stdout.txt`
- `ci/jobs/<job_id>/attempts/<attempt_number>/logs/final/stderr.txt`
- `ci/jobs/<job_id>/attempts/<attempt_number>/logs/final/display.txt`
- `ci/jobs/<job_id>/attempts/<attempt_number>/artifacts/<relative path>`
- `ci/jobs/<job_id>/attempts/<attempt_number>/artifacts/manifest.json`

## Limits

- fixed runner-wide timeout in v1
- no timeout override in the job API
- max log size per stream: 50 MB
- max total artifact upload per attempt: 500 MB
- max single artifact file: 100 MB

Log overflow truncates with an explicit marker.
Oversized artifacts fail upload and are recorded on the attempt.

## Security Posture

The MVP assumes a trusted internal environment.

Important implications:

- outbound network is allowed by default
- repo code runs in OCI containers, but this is not a hardened sandbox
- write-capable git credentials are out of scope
- untrusted execution will require a separate design pass for isolation,
  credential scope, network policy, image policy, and filesystem controls
