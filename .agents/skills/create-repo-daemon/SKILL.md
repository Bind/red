---
name: create-repo-daemon
description: Create or update repo daemons for this codebase. Use when adding a new `*.daemon.md` audit agent, adding supporting `AGENTS.md` guidance for a subtree, or tightening an existing daemon so it stays narrow, memory-friendly, and compatible with the runner-owned `track` and `complete` protocol.
---

# Create Repo Daemon

Create repo daemons using the current redc pattern:

- keep daemon bodies simple and responsibility-focused
- keep `track` / `complete` protocol guidance out of the daemon body
- put universal daemon behavior in the runner prompt pre/postamble
- add only concise domain-specific narrowing guidance in the daemon file

## Workflow

1. Find the ownership boundary.

- Choose the narrowest folder or repo surface the daemon should own.
- Prefer placing the daemon file inside the owned subtree when the audit is local.
- Use the daemon filename as the stable audit identity, e.g. `infra-audit.daemon.md`.

2. Decide whether the subtree needs an `AGENTS.md`.

- Add `AGENTS.md` when the daemon audits a folder with local patterns, invariants, or reading order that another agent would not know.
- Skip `AGENTS.md` when the daemon can be anchored by obvious repo-wide contracts and a small daemon body.

3. Write the daemon body as a responsibility statement plus domain guidance.

- State what the daemon is responsible for.
- State the narrowest canonical source or contract.
- Tell it how to stay narrow.
- List the main mismatch classes to flag.
- Do not include instructions for calling `track` or `complete`; the runner already owns that protocol.

4. Keep the daemon body short.

- Prefer 6-20 lines of real guidance.
- Avoid restating generic audit behavior that belongs in the runner.
- Only include repo-specific authority ordering and failure modes.

5. Bias toward the smallest authoritative source needed.

- For docs daemons: start from docs, validate against `justfile`, manifests, CLI entrypoints, then handler code only if needed.
- For contract daemons: start from the shared package or canonical module, then per-app tests and handler wiring.
- For infra daemons: start from local `AGENTS.md`, compose manifests, scripts, ingress config, and only pull adjacent repo files when an infra contract points there.

6. Make the daemon memory-friendly.

- Phrase guidance so the daemon can reuse tracked facts when files are unchanged.
- Encourage validating one service, surface, or contract at a time.
- Prefer stable subjects such as a root README, a shared package contract, or an app-level docs surface.

## Daemon Templates

Use this shape for most daemon files:

```md
---
name: example-daemon
description: One-sentence description of the audit responsibility.
---

You are responsible for ensuring <owned surface> stays aligned with <canonical contract>.

Stay narrow:

- treat <canonical file/package/doc> as the source of truth
- validate one <service/doc/contract> at a time
- prefer <tests/manifests/docs/handlers> over broad exploration

Use the smallest authoritative source needed to validate a claim:

- <authority 1>
- <authority 2>
- <authority 3>

Flag:

- <failure class 1>
- <failure class 2>
- <failure class 3>
```

Use this shape for subtree `AGENTS.md` files:

```md
# <Area> Agents Guide

State what the directory owns and why changes there are risky.

## Progressive Disclosure

- start from the narrowest relevant subarea
- name the adjacent repo files that are legitimate external dependencies
- explicitly say not to read the whole repo by default

## Core Invariants

- list the local contracts that should remain true

## Audit Checklist

- list the drift patterns that matter in this area
```

## What Good Looks Like

Good daemon body:

- responsibility-focused
- specific about source-of-truth files
- explicit about the highest-value mismatch classes
- short enough that the daemon does not waste tokens on restated protocol

Bad daemon body:

- repeats how `track` works
- repeats how `complete` works
- tells the daemon to audit the whole repo without a narrow authority order
- mixes universal runner behavior with domain-specific guidance

## Repo Notes

- Keep repo-owned skills under `.agents/skills/`.
- Do not create repo skills under `.codex/`.
- For redc daemons, favor `AGENTS.md` in ownership subtrees that have meaningful local invariants, especially under `infra/`.
