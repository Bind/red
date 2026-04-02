# Git SDK Lab

Isolated experiment for a git-backed SDK in the shape of managed Git storage systems such as `code.storage`.

This lab is intentionally separate from the main `redc` app. It gives us a place to work out the SDK surface and local execution model before we decide whether any of it should move into production code.

## Goals

The initial API shape is modeled around a few core flows:

- Create and discover repositories
- Create direct commits without shelling out to local git
- Manage branches and refs
- Read repository state back through the SDK
- Produce authenticated Git remote URLs when we want standard git clients involved

## Starting Point

The current scaffold includes:

- `src/index.ts`: draft TypeScript interfaces for the SDK surface
- `src/manual.ts`: tiny CLI for printing the current experiment shape

## Commands

From repo root:

```bash
just git-sdk-lab-manual list
just git-sdk-lab-manual describe
```

## Current SDK Shape

The draft SDK is centered on a storage client plus repository handles:

- `GitStorageExperiment`: create repos, fetch repos, list repos
- `GitRepoExperiment`: inspect refs, list files, create commits, build authenticated remote URLs
- `createCommit` builder: stage file writes, deletes, and send a commit atomically

## Next Questions

- What is the persistence model: bare repos on disk, object store, or a database-indexed git layer?
- Do we want direct-write commits to be implemented via libgit bindings, git subprocesses, or a custom object writer?
- Should remote URLs mint short-lived tokens on demand, and if so what signs them?
- How much of the API should be branch-based versus commit/tree based?
