# Git Server

Git-backed storage service with:

- a native Zig smart-HTTP server
- MinIO/S3-backed object and ref storage
- a thin TypeScript client that talks to the running server over HTTP

The current direction is explicit:

- normal Git operations use standard smart HTTP against the remote `grs` service
- SDK reads use `grs` control-plane endpoints
- the SDK does not shell out to local `git`
- the SDK does not create temp worktrees or depend on local filesystem state

## Goals

Keep the client shape close to `code.storage`, but only for operations that can be satisfied by the remote `grs` service we already have today.

That means:

- mint authenticated remote URLs for standard Git clients
- read repo state, branches, commits, files, and diffs through HTTP
- avoid hidden local workflows in API or SDK code
- keep `red` review/change semantics above the storage layer

## Layout

- `src/core/`: TypeScript client interfaces, auth helpers, and dev-stack helpers
- `src/tests/`: Bun tests and live integration coverage
- `zig/`: native Zig grs implementation and protocol/storage code

## Commands

From repo root:

```bash
just git-server-up
just git-server-test
just gs-integration
```

## Interfaces

The package currently has three explicit interfaces:

1. runtime configuration
2. Git smart-HTTP transport
3. TypeScript client surface

### Runtime Configuration

The server process requires:

- `GIT_SERVER_PUBLIC_URL`
- `GIT_SERVER_PORT`
- `GIT_SERVER_S3_ENDPOINT`
- `GIT_SERVER_S3_REGION`
- `GIT_SERVER_S3_BUCKET`
- `GIT_SERVER_S3_PREFIX`
- `GIT_SERVER_S3_ACCESS_KEY_ID`
- `GIT_SERVER_S3_SECRET_ACCESS_KEY`
- `GIT_SERVER_ADMIN_USERNAME`
- `GIT_SERVER_ADMIN_PASSWORD`
- `GIT_SERVER_AUTH_TOKEN_SECRET`

Local defaults should come from compose, not the server binary.

### Auth Contract

The server accepts Basic Auth over smart HTTP and control-plane HTTP.

Supported credentials:

- admin credentials
  - username = `GIT_SERVER_ADMIN_USERNAME`
  - password = `GIT_SERVER_ADMIN_PASSWORD`
- signed repo-scoped access tokens
  - username = actor id
  - password = signed token
  - token payload includes `sub`, `repoId`, `access`, and `exp`

The signing secret is `GIT_SERVER_AUTH_TOKEN_SECRET`.

### Git HTTP Surface

Smart-HTTP routes:

- `GET /<owner>/<repo>.git/info/refs?service=git-upload-pack`
- `GET /<owner>/<repo>.git/info/refs?service=git-receive-pack`
- `POST /<owner>/<repo>.git/git-upload-pack`
- `POST /<owner>/<repo>.git/git-receive-pack`

Health/info route:

- `GET /`

### Control-Plane HTTP Surface

Current read routes:

- `GET /api/repos/<owner>/<repo>`
- `GET /api/repos/<owner>/<repo>/branches`
- `GET /api/repos/<owner>/<repo>/commits?ref=<ref>&limit=<n>`
- `GET /api/repos/<owner>/<repo>/file?path=<path>&ref=<ref>`
- `GET /api/repos/<owner>/<repo>/compare?base=<ref>&head=<ref>[&patch=1]`

These are what the API and the remote-only SDK use for reads.

### Storage Contract

Git objects and refs are persisted in S3/MinIO under a repo-scoped layout:

- `repos/<owner>/<repo>/objects/<sha-prefix>/<sha-rest>`
- `repos/<owner>/<repo>/refs/heads/<branch>`
- `repos/<owner>/<repo>/refs/tags/<tag>`

The server is responsible for:

- authenticating requests
- mapping repo identity to storage prefix
- reading and writing Git objects
- reading and writing refs

## SDK Surface

The TypeScript contract lives in [src/core/api.ts](/Users/db/workspace/redc/apps/grs/src/core/api.ts).

Current client shape:

- `GitStorage`
  - `getRepo(id)`
  - `getRepoByName(owner, name)`
- `Repo`
  - `info()`
  - `getRemoteUrl(options)`
  - `getCommitDiff(range)`
  - `readTextFile({ ref, path })`
  - `listCommits({ ref?, limit? })`
  - `listBranches()`

Important constraint:

- only methods backed by existing `grs` endpoints are kept
- methods that required local `git`, temp worktrees, or filesystem state were removed

Current implementation note:

- [src/core/git-sdk.ts](/Users/db/workspace/redc/apps/grs/src/core/git-sdk.ts) is a thin remote client for `grs`

## Behavior Notes

- `getRemoteUrl(...)`
  - returns authenticated smart-HTTP URLs when the client has a signing secret or credential issuer
- `readTextFile(...)`
  - returns UTF-8 text
  - returns `null` when the file does not exist at that ref
- `getCommitDiff(...)`
  - supports `includePatch?: boolean`
  - returns per-file `additions` and `deletions`
  - returns top-level `totalAdditions` and `totalDeletions`
- `listBranches()`
  - returns short branch names like `main`
  - includes the branch head SHA plus message/timestamp when available

## Integration Coverage

The live integration suite covers the important server behaviors directly:

- first push into a new repo
- compare endpoint over nested paths
- control-plane repo/branch/commit/file/compare reads
- auth parity between control-plane and smart HTTP
- read credentials can clone/fetch
- read-only credentials cannot push

Run it with:

```bash
just gs-integration
```

## Docker Compose

The root compose stack includes:

- `s3`
- `init`
- `grs`

Run it from repo root:

```bash
just git-server-up
```

The local compose defaults are:

- `GIT_SERVER_PORT=8080`
- `GIT_SERVER_PUBLIC_URL=http://127.0.0.1:9080`
- `GIT_SERVER_S3_ENDPOINT=http://s3:9000`
- `GIT_SERVER_S3_REGION=us-east-1`
- `GIT_SERVER_S3_BUCKET=grs-repos`
- `GIT_SERVER_S3_PREFIX=repos`
- `GIT_SERVER_S3_ACCESS_KEY_ID=minioadmin`
- `GIT_SERVER_S3_SECRET_ACCESS_KEY=minioadmin`
- `GIT_SERVER_ADMIN_USERNAME=admin`
- `GIT_SERVER_ADMIN_PASSWORD=admin`
- `GIT_SERVER_AUTH_TOKEN_SECRET=dev-git-server-secret`

## Fit

`gitty` is treated as the Git-native transport and storage engine, not as the product model.

That means:

- `gitty` owns Git protocol behavior
- `red` owns change/review behavior
- standard Git clients should still be able to clone, fetch, and push against repos served by the system

## App Boundary

The intended split remains:

- grs + S3/MinIO store Git objects and refs
- the broader app stores repo metadata and lifecycle state

The grs service should stay narrow:

- authenticate requests
- map repo identity to storage prefix
- serve push/fetch/clone
- serve read-oriented control-plane endpoints

The broader app should remain the source of truth for:

- whether a repo exists
- repo settings and lifecycle
- access policy above Git transport
- `red` review/change integration
