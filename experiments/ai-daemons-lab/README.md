# AI Daemons Lab

Example consumer of [`@red/daemons`](../../pkg/daemons/README.md).

Daemons are authored as markdown files with a `.daemon.md` suffix anywhere
under the repo. Each daemon's scope — the directory it can read and write —
is the directory the file lives in.

## What's here

- `readme-links.daemon.md` — read-only check that every `just <recipe>`
  reference in this experiment's `README.md` has a matching entry in its
  `justfile`. Surfaces documentation drift without editing anything. The
  daemon's scope is this directory, so it can read the sibling `README.md`
  and `justfile` but nothing outside the experiment.

## Run

Prerequisite: [`codex login`](https://developers.openai.com/codex/auth) so the
Codex SDK picks up your ChatGPT subscription.

```bash
cd experiments/ai-daemons-lab
just list                 # walk for .daemon.md files and list them
just show readme-links    # print the daemon's frontmatter + body + scope
just run  readme-links    # invoke it; prints the complete payload as JSON
```

Each run emits one `daemon.run.started`, one `daemon.turn.*` pair per turn,
one `daemon.finding` per finding, and one `daemon.run.completed` wide-event to
stdout as JSONL.

## Writing your own

Drop any `*.daemon.md` anywhere in this directory (or a subdirectory). The
daemon's working directory becomes the directory it lives in, so place the
file next to what it maintains.

Frontmatter is two fields:

```yaml
---
name: kebab-case-unique
description: One sentence for `red daemons list`.
---
```

The markdown body is the daemon's brief. At the end of a run, it must reply
with ONLY a fenced `complete` block; see `@red/daemons` README for the
payload shape.
