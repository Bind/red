# Git Server

Git-backed storage service and SDK in the shape of managed Git storage systems such as `code.storage`.

## Goals

The SDK surface is intentionally being pulled toward `code.storage` semantics:

- Create and discover repositories
- Create direct commits without shelling out to local git
- Read diffs and repository state back through the SDK
- Produce authenticated Git remote URLs when we want standard git clients involved
- Support normal `git clone`, `git fetch`, and `git push` against repos created by the SDK
- Leave `redc` review/change concepts outside the storage layer

## Starting Point

The current scaffold includes:

- `src/core/`: SDK interfaces, adapters, runtime helpers, and the MinIO-backed Bun+WASM server
- `src/examples/`: static SDK usage examples
- `src/manual/`: the small CLI entrypoint
- `src/tests/`: Bun tests for examples and live integration
- `vendor/gitty`: vendored upstream `gitty` checkout pinned for local experimentation

## Commands

From repo root:

```bash
just git-server-manual list
just git-server-manual describe
just git-server-manual example
just git-server-manual forked-example
just git-server-manual integration
just git-server-up
just git-server-integration-test
```

## Interface

The `git-server` package has three explicit interfaces:

1. runtime configuration
2. Git smart-HTTP transport
3. TypeScript SDK surface

### Runtime Configuration

The server process requires these environment variables on boot:

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

Code-level defaults are intentionally not provided. Missing config is treated as a boot error.

### Auth Contract

The server accepts Basic Auth over HTTPS smart HTTP.

There are two credential types:

- admin credentials
  - username = `GIT_SERVER_ADMIN_USERNAME`
  - password = `GIT_SERVER_ADMIN_PASSWORD`
  - full access across repos
- signed Git access tokens
  - username = actor id
  - password = signed token
  - token payload includes:
    - `sub`
    - `repoId`
    - `access`
    - `exp`

The token secret is `GIT_SERVER_AUTH_TOKEN_SECRET`.

### Git HTTP Surface

The Git transport surface is standard smart HTTP.

Expected repo routes:

- `GET /<owner>/<repo>.git/info/refs?service=git-upload-pack`
- `GET /<owner>/<repo>.git/info/refs?service=git-receive-pack`
- `POST /<owner>/<repo>.git/git-upload-pack`
- `POST /<owner>/<repo>.git/git-receive-pack`

Health/info route:

- `GET /`

That root route returns a small JSON status payload describing the running server mode and auth status.

### Storage Contract

Git objects and refs are persisted in S3/MinIO under a repo-scoped prefix layout:

- `repos/<owner>/<repo>/objects/<sha-prefix>/<sha-rest>`
- `repos/<owner>/<repo>/refs/heads/<branch>`
- `repos/<owner>/<repo>/refs/tags/<tag>`

The server is responsible for:

- authenticating requests
- mapping repo identity to storage prefix
- reading and writing Git objects
- reading and writing refs

### SDK Surface

The TypeScript SDK contract lives in [src/core/api.ts](/Users/db/workspace/redc/git-server/src/core/api.ts).

Main interfaces:

- `GitStorage`
  - `createRepo(options)`
  - `getRepo(id)`
  - `getRepoByName(owner, name)`
  - `listRepos()`
- `Repo`
  - `info()`
  - `getRemoteUrl(options)`
  - `createCommit(options)`
  - `getCommitDiff(range)`
  - `readTextFile({ ref, path })`
  - `listRefs()`
  - `listBranches()`
  - `resolveRef(name)`
  - `createBranch(name, fromSha)`
  - `updateBranch(name, toSha, expectedOldSha?)`
  - `listFiles(ref?)`

Repo identity is stable and canonical:

- `repo.id === ${owner}/${name}`

Behavior notes:

- `readTextFile(...)`
  - returns UTF-8 text
  - returns `null` when the file does not exist at that ref
  - throws for real ref or process failures
- `getCommitDiff(...)`
  - supports `includePatch?: boolean`
  - returns per-file `additions` and `deletions`
  - returns top-level `totalAdditions` and `totalDeletions`
  - can return both per-file and top-level unified patch text
- `listBranches()`
  - returns short branch names like `main`
  - currently sets `protected: false`
- `RefInfo.timestamp`
  - commit timestamp in ISO-8601

Current implementation notes:

- [src/core/git-sdk.ts](/Users/db/workspace/redc/git-server/src/core/git-sdk.ts) is the live SDK path against the running server
- [src/core/mock-git-sdk.ts](/Users/db/workspace/redc/git-server/src/core/mock-git-sdk.ts) is the static/example implementation
- `createRepo(...)` is still logical in the live SDK path and needs app-backed repo metadata integration later

## Current API Shape

The current experiment is organized around:

- `GitStorage`
  - `createRepo(...)`
  - `getRepo(...)`
  - `getRepoByName(...)`
  - `listRepos()`
- `Repo`
  - `info()`
  - `getRemoteUrl(...)`
  - `createCommit(...)`
  - `getCommitDiff(...)`
  - `readTextFile(...)`
  - `listRefs()`
  - `listBranches()`
  - `resolveRef(...)`
  - `createBranch(...)`
  - `updateBranch(...)`
  - `listFiles(...)`

That keeps the storage layer close to `code.storage`, while `redc` remains free to define its own review/change model on top.

## Example

There is now a concrete example in `src/examples/sdk-examples.ts` that shows:

- creating a repo through `GitStorage`
- minting a normal Git remote URL
- creating a direct commit through the SDK
- opening a `redc` change from `baseRef` and `headRef`
- showing the equivalent normal Git push flow

Run it with:

```bash
just git-server-manual example
```

The example uses this shape:

```ts
const store = new MockGitSdk({
  publicUrl: "https://git.example.redc.internal",
  defaultOwner: "redc",
});

const repo = await store.createRepo({
  name: "agent-scratch",
  defaultBranch: "main",
  visibility: "private",
});

const remote = await repo.getRemoteUrl({
  actorId: "agent-123",
  ttlSeconds: 3600,
});

const commit = await repo
  .createCommit({
    branch: "refs/heads/experiments/sdk-example",
    message: "Seed experiment branch",
    author: {
      name: "redc agent",
      email: "agent@redc.local",
    },
  })
  .put("README.md", "# agent-scratch\n")
  .put("src/index.ts", 'export const status = "draft";\n')
  .send();
```

There is also a fork-like example for the model where `redc` has a canonical repo and agents push to their own writable repo:

```bash
just git-server-manual forked-example
```

That example shows:

- a canonical base repo like `redc/app`
- a separate writable repo like `agents/app-agent-123`
- a normal push target minted from the agent repo
- a `redc` change opened from `baseRepo/baseRef` to `headRepo/headRef`

## Live Integration Harness

There is now a live integration harness that proves the clone semantics against the MinIO-backed Bun+WASM Git server:

```bash
just git-server-manual integration
just git-server-integration-test
```

The harness does this end to end:

1. boots a real Git server
2. creates a repo through the SDK
3. mints an HTTP remote URL
4. uses a real local Git client to push `main` and a feature branch
5. resolves refs through the SDK
6. computes a diff through the SDK
7. uses the direct `createCommit(...)` path to write another branch
8. compares the pushed path and the SDK-written path

The integration test command also proves the first auth slice:

- read credentials can clone and fetch
- write credentials can push
- read-only credentials cannot push

## Docker Compose

The root `docker-compose.yml` now includes:

- `minio`: object storage with a persistent Docker volume
- `minio-init`: bucket bootstrap for the configured Git storage bucket
- `git-server`: a Bun+WASM server using vendored `gitty` protocol logic with MinIO-backed object/ref storage

Run it from repo root:

```bash
just git-server-up
```

The compose stack now defaults to the MinIO-backed path and uses vendored `gitty` WASM plus repo-prefixed keys like:

- `repos/<owner>/<repo>/objects/<sha-prefix>/<sha-rest>`
- `repos/<owner>/<repo>/refs/heads/<branch>`

The git server now uses a cleaner bootstrap/auth surface:

- `GIT_SERVER_ADMIN_USERNAME` and `GIT_SERVER_ADMIN_PASSWORD` define an all-repos admin principal
- `GIT_SERVER_AUTH_TOKEN_SECRET` signs repo-scoped read/write Git credentials
- the lab SDK mints short-lived repo-scoped remote credentials from that token secret for integration tests

For local MinIO development, you do not need to explicitly set every `GIT_SERVER_*` variable if you accept the compose defaults. The effective local defaults are:

- `GIT_SERVER_PORT=8080`
- `GIT_SERVER_PUBLIC_URL=http://127.0.0.1:9080`
- `GIT_SERVER_S3_ENDPOINT=http://minio:9000`
- `GIT_SERVER_S3_REGION=us-east-1`
- `GIT_SERVER_S3_BUCKET=git-server-repos`
- `GIT_SERVER_S3_PREFIX=repos`
- `GIT_SERVER_S3_ACCESS_KEY_ID=minioadmin`
- `GIT_SERVER_S3_SECRET_ACCESS_KEY=minioadmin`
- `GIT_SERVER_ADMIN_USERNAME=admin`
- `GIT_SERVER_ADMIN_PASSWORD=admin`
- `GIT_SERVER_AUTH_TOKEN_SECRET=dev-git-server-secret`

All of the `GIT_SERVER_*` variables above are now treated as required server config. The code does not provide fallback defaults for them; compose is the only place local defaults should live.

## Gitty Fit

`gitty` is treated as a candidate storage engine, not as the product model.

That means:

- `gitty` can own Git-native behavior and smart HTTP transport
- `redc` can define its own change/review model separately
- we preserve the option to swap the backend later if `gitty` proves too immature or too limiting

One explicit requirement for this experiment is that repos created through the SDK must still behave like normal Git remotes. A developer or agent should be able to mint a remote URL, add it as `origin`, and run a standard `git push` without going through a custom client.

## App Integration TODO

Before this moves into the broader app, repo metadata needs to become a real control-plane concern in the app database.

The intended split is:

- Git server + S3/MinIO store Git objects and refs
- the broader app stores repo metadata and lifecycle state

That means `createRepo(...)` should eventually be backed by a durable app-level repo record rather than the current in-memory experiment behavior.

The app-level repo record should own fields like:

- `id`
- `owner`
- `name`
- `defaultBranch`
- `visibility`
- `storagePrefix`
- `createdAt`
- `archivedAt?`

The Git server should stay narrow:

- authenticate Git requests
- map repo identity to a storage prefix
- serve push/fetch/clone
- persist refs and objects

The broader app should remain the source of truth for:

- whether a repo exists
- repo settings and lifecycle
- who can access it
- future review/change integration

## Next Questions

- Which `code.storage` semantics do we want to mirror exactly, and which do we intentionally omit?
- What exact `gitty` primitives exist for repo creation, refs, trees, and commits?
- Does `gitty` expose enough hooks for repo-scoped auth, base-repo sync, and short-lived remote credentials?
- Where should repo metadata live: inside the git backend, in the main app database, or split across both?
