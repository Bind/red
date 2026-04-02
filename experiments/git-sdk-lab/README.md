# Git SDK Lab

Isolated experiment for a git-backed SDK in the shape of managed Git storage systems such as `code.storage`.

This lab is intentionally separate from the main `redc` app. It gives us a place to work out the SDK surface and local execution model before we decide whether any of it should move into production code.

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

- `src/index.ts`: a `code.storage`-style API surface centered on `GitStorage` and `Repo`
- `src/gitty-adapter.ts`: placeholder `gitty` implementation of that storage surface
- `src/manual.ts`: tiny CLI for printing the current architecture

## Commands

From repo root:

```bash
just git-sdk-lab-manual list
just git-sdk-lab-manual describe
just git-sdk-lab-manual example
just git-sdk-lab-manual forked-example
```

## Current API Shape

The current experiment is organized around:

- `GitStorage`
  - `createRepo(...)`
  - `getRepo(...)`
  - `listRepos()`
- `Repo`
  - `info()`
  - `getRemoteUrl(...)`
  - `createCommit(...)`
  - `getCommitDiff(...)`
  - `listRefs()`
  - `resolveRef(...)`
  - `createBranch(...)`
  - `updateBranch(...)`
  - `listFiles(...)`

That keeps the storage layer close to `code.storage`, while `redc` remains free to define its own review/change model on top.

## Example

There is now a concrete example in `src/example.ts` that shows:

- creating a repo through `GitStorage`
- minting a normal Git remote URL
- creating a direct commit through the SDK
- opening a `redc` change from `baseRef` and `headRef`
- showing the equivalent normal Git push flow

Run it with:

```bash
just git-sdk-lab-manual example
```

The example uses this shape:

```ts
const store = new GittyAdapter({
  baseUrl: "https://git.example.redc.internal",
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
just git-sdk-lab-manual forked-example
```

That example shows:

- a canonical base repo like `redc/app`
- a separate writable repo like `agents/app-agent-123`
- a normal push target minted from the agent repo
- a `redc` change opened from `baseRepo/baseRef` to `headRepo/headRef`

## Gitty Fit

`gitty` is treated as a candidate storage engine, not as the product model.

That means:

- `gitty` can own Git-native behavior and smart HTTP transport
- `redc` can define its own change/review model separately
- we preserve the option to swap the backend later if `gitty` proves too immature or too limiting

One explicit requirement for this experiment is that repos created through the SDK must still behave like normal Git remotes. A developer or agent should be able to mint a remote URL, add it as `origin`, and run a standard `git push` without going through a custom client.

## Next Questions

- Which `code.storage` semantics do we want to mirror exactly, and which do we intentionally omit?
- What exact `gitty` primitives exist for repo creation, refs, trees, and commits?
- Does `gitty` expose enough hooks for repo-scoped auth, base-repo sync, and short-lived remote credentials?
- Where should repo metadata live: inside the git backend, in the main app database, or split across both?
