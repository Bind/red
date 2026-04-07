# Git Server Control Plane Experiment

## Goal

Reduce coupling between `redc-api` and the local `GitSdk` abstraction while improving reliability and observability for forge-style read paths.

## Scope

This experiment adds a JSON control plane to `git-server` for read-heavy operations:

- repo metadata
- branch listing
- commit listing
- file reads
- compare/diff

`redc-api` can switch its repository read path to this control plane with:

```bash
GIT_STORAGE_CONTROL_PLANE_ENABLED=1
```

## Why

The existing path makes `redc-api` talk to `git-server` through `GitSdk`, which hides a remote dependency behind local-looking repo handles and shell-outs. That made failure analysis difficult, especially around the Bun/WASM smart-HTTP boundary.

The new read path is explicit:

`redc-api` -> HTTP JSON -> `git-server`

This does not replace smart HTTP yet. Standard `git clone/fetch/push` still use the existing git server path.

## Current Design

- `git-server` exposes `/api/repos/:owner/:repo[...]` read endpoints
- the control plane materializes a temporary bare repo from object/ref storage and runs local `git` commands for reads
- `redc-api` uses `GitServerHttpRepositoryProvider` when the control-plane flag is enabled
- smart HTTP remains unchanged for write flows and normal Git clients

## Intended Follow-Up

- replace the WASM smart-HTTP request path with a native server implementation
- move direct write/create operations onto explicit `git-server` endpoints
- add request IDs, timing, and structured storage logs on control-plane and smart-HTTP routes
- add an end-to-end smoke test that covers branch/commit/file reads and `git push`
