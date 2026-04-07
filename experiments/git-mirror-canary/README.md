# Git Mirror Canary

Long-running experiment for tracking git-server capability by following active upstream repositories, mirroring them into a target remote, and emitting issue events when the mirror loop fails or drifts.

## What It Does

- polls configured source repositories on an interval
- keeps a local bare cache for efficient fetches
- pushes `--mirror` into configured target remotes
- verifies that a tracked ref reached the target
- persists repo status and event history in SQLite
- optionally POSTs issue and progress events to a webhook
- exposes HTTP status routes for deployment health checks

## Endpoints

- `GET /health`
- `GET /status`
- `POST /run`

## Config

The service reads repo definitions from `GIT_MIRROR_CANARY_REPOS_FILE` or `GIT_MIRROR_CANARY_REPOS_JSON`.

Example:

```json
[
  {
    "id": "github/git",
    "sourceUrl": "https://github.com/git/git.git",
    "targetUrl": "https://admin:secret@git.internal/redc/git.git",
    "trackedRef": "refs/heads/master",
    "pollIntervalMs": 60000
  }
]
```

Main env vars:

- `GIT_MIRROR_CANARY_HOST`
- `GIT_MIRROR_CANARY_PORT`
- `GIT_MIRROR_CANARY_POLL_INTERVAL_MS`
- `GIT_MIRROR_CANARY_DATA_DIR`
- `GIT_MIRROR_CANARY_CACHE_DIR`
- `GIT_MIRROR_CANARY_STATE_DB_PATH`
- `GIT_MIRROR_CANARY_REPOS_FILE`
- `GIT_MIRROR_CANARY_REPOS_JSON`
- `GIT_MIRROR_CANARY_EVENT_WEBHOOK_URL`

## Run

```bash
cat > /tmp/git-mirror-canary-repos.json <<'JSON'
[
  {
    "id": "github/git",
    "sourceUrl": "https://github.com/git/git.git",
    "targetUrl": "https://admin:secret@git.internal/redc/git.git",
    "trackedRef": "refs/heads/master"
  }
]
JSON

just git-mirror-canary-install
GIT_MIRROR_CANARY_REPOS_FILE=/tmp/git-mirror-canary-repos.json just git-mirror-canary-serve
```

## Deploy

The included `docker-compose.yml` is strict on env and suitable for a small always-on deployment:

```bash
GIT_MIRROR_CANARY_HOST_CONFIG_DIR=/absolute/path/to/config \
GIT_MIRROR_CANARY_HOST_DATA_DIR=/absolute/path/to/data \
GIT_MIRROR_CANARY_PUBLISHED_PORT=4080 \
just git-mirror-canary-compose-up
```

Put `repos.json` under the mounted config directory. If `GIT_MIRROR_CANARY_EVENT_WEBHOOK_URL` is set, every mirror issue is POSTed there as JSON.

## Verify

```bash
just git-mirror-canary-test
just git-mirror-canary-compose-e2e
```
