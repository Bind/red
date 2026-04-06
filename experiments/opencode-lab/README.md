# OpenCode Lab

Isolated spike for evaluating `opencode` as a runner/session backend for `redc`.

This lab is intentionally separate from the main app and current Codex runner.
It focuses on three questions:

1. Can we connect to a remote `opencode serve` instance with the SDK?
2. Can we stream session output in real time while a task runs?
3. How should we handle git repo mounts for server-side execution?
4. Can we manually drive `opencode` inside a container using host OpenCode auth?

## Model

The installed SDK adds an important capability: the client can target a
server-side repo path via `directory`.

- A single remote `opencode serve` instance can target different mounted repos
  by sending `directory=/srv/repos/...` on requests.
- A dedicated repo-rooted server is still useful for local testing and for
  simpler isolation, which is what `serve-repo.ts` gives us.

This is different from the current Codex runner, which clones repos into a
throwaway container.

## Commands

From repo root:

```bash
just opencode-lab-manual list
just opencode-lab-serve /path/to/repo
just opencode-lab-manual inspect --base-url http://127.0.0.1:4096
just opencode-lab-manual run-task \
  --base-url http://127.0.0.1:4096 \
  --directory /srv/repos/redc \
  --title "redc spike" \
  --prompt "Summarize the current repository architecture"

just opencode-lab-container-build
just opencode-lab-container-test /Users/db/workspace/redc experiments/opencode-lab/prompts/respond-ok.txt
just opencode-lab-serve-capture /Users/db/workspace/redc experiments/opencode-lab/prompts/respond-ok.txt /tmp/opencode-session.jsonl
just opencode-lab-pr-summary https://github.com/example/repo.git main feature-branch /tmp/opencode-pr-summary
just opencode-lab-pr-summary-run https://github.com/example/repo.git main feature-branch /tmp/opencode-pr-summary-run
```

## Manual CLI

`manual.ts` supports:

- `list`: print available commands
- `health`: check server health/version
- `inspect`: print current project/path/config info
- `sessions`: list sessions
- `events`: subscribe to the server SSE stream
- `run-task`: create or reuse a session, stream task output, then print the final response

Useful flags:

- `--base-url <url>`: remote server URL
- `--directory <server-path>`: mounted repo/worktree path on the remote server
- `--username <name>` and `--password <value>`: HTTP basic auth for protected servers
- `--session-id <id>`: reuse an existing session
- `--title <text>`: create a session if no session id is provided
- `--prompt <text>` or `--prompt-file <path>`: task prompt
- `--schema-file <path>`: JSON schema for structured output
- `--agent <name>`: request a specific agent
- `--model <provider/model>`: request a specific model
- `--system <text>`: override the system prompt for this task
- `--variant <name>`: request a named task variant if the server supports it

## Repo Mounts

There are now two mount models to evaluate:

1. Single server, many repos:
   Start one remote `opencode serve`, then target mounted repo paths with
   `--directory /srv/repos/<repo>`.

2. Dedicated server per repo/worktree:
   `serve-repo.ts` starts `opencode serve` with `cwd` set to a repo path. In a
   real remote execution setup, this path would be a mounted worktree or
   checked-out repo directory on the server.

3. Direct container execution:
   `container/run-in-container.sh` mounts a repo at `/workspace`, stages a temp
   copy of `~/.local/share/opencode/auth.json`, and runs `opencode run` inside
   the container.

4. Containerized server plus raw event capture:
   `container/run-serve-capture.sh` starts `opencode serve` in a container,
   mounts a repo at `/workspace`, subscribes to `/event`, triggers a prompt,
   and writes the full raw session stream to a JSONL artifact.

5. Manual PR summary:
   `src/pr-summary-manual.ts` clones a repo into a temp worktree, fetches base
   and head refs, renders the existing product summary prompt plus a prepared git
   comparison artifact, and can run in two modes:
   - `--driver serve`: use containerized `opencode serve`, capture the raw session
     stream, and attempt to fetch the final assistant response.
   - `--driver run`: use containerized `opencode run --format json`, capture the
     raw JSON event stream, and extract the final assistant response.

Current finding:
- The `serve` path is useful for raw session-stream experiments, but it is not
  yet reliable for the PR-summary job. Even with a prepared diff artifact,
  stricter system instructions, JSON schema output, and a review-only
  `opencode.json`, the server-driven agent still drifts into exploratory behavior
  and times out.
- The `run` path works for the same prepared comparison and produces a valid
  `summary.json` artifact today.

Example:

```bash
just opencode-lab-serve /srv/repos/redc --port 4096 --hostname 0.0.0.0

just opencode-lab-manual inspect \
  --base-url http://127.0.0.1:4096 \
  --directory /srv/repos/redc
```

## Current Limits

- This is a manual spike, not yet wired into `src/jobs/worker.ts`.
- It assumes the `opencode` CLI is installed wherever `serve:repo` runs.
- It does not yet clone repos itself; it expects the repo to already exist on
  the server or to be mounted there.
- The container harness uses OpenCode auth state, not `~/.codex/auth.json`
  directly. If you want to test a ChatGPT/OpenAI subscription path, first log
  in with `opencode auth login` on the host so `~/.local/share/opencode/auth.json`
  contains `openai` credentials.
- The SDK/server surface can evolve quickly, so verify against the running `/doc` spec.
