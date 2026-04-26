---
name: create-repo-daemon
description: Create or update repo daemons for high-judgment, non-overlapping best-practice audits in this codebase. Use when adding a new `*.daemon.md` audit agent, adding supporting `AGENTS.md` guidance for a subtree, or tightening an existing daemon so it stays narrow, memory-friendly, and focused on consistency and operator-review concerns rather than lint-style checks.
---

# Create Repo Daemon

Create repo daemons using the current red pattern:

- keep daemon bodies simple and responsibility-focused
- make each daemon own one primary axis only: docs surface, shared contract, topology wiring, environment layering, or operator workflow
- require explicit out-of-scope guidance so daemon responsibilities do not overlap
- use daemons to enforce best practices and consistency for high-judgment concerns, not to reimplement lint or typecheck rules
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

- Start with a one-line “Simple job:” description in very plain English before the detailed guidance.
- That line should sound like clear caveman English, but still be real English.
- Good examples:
  - `Simple job: make sure the docs are right about commands and app surfaces.`
  - `Simple job: make sure the stack wiring files agree about what talks to what.`
  - `Simple job: make sure each infra part lives in the right layer.`
  - `Simple job: make sure infra scripts, docs, and operator steps still match reality.`
- State what the daemon is responsible for.
- State the narrowest canonical source or contract.
- Tell it how to stay narrow.
- State what it is not responsible for.
- List the main mismatch classes to flag.
- Do not include instructions for calling `track` or `complete`; the runner already owns that protocol.

4. Keep the daemon body short.

- Prefer 6-20 lines of real guidance.
- Avoid restating generic audit behavior that belongs in the runner.
- Only include repo-specific authority ordering and failure modes.

5. Bias toward the smallest authoritative source needed.

- Pick one narrow authority chain and stay on it unless that chain cannot resolve the claim.
- Good examples:
  - a documentation daemon should ensure `README.md` or other owned docs stay aligned with the real command, manifest, or route surface
  - a logging or observability daemon should ensure apps use the shared middleware or instrumentation entrypoint rather than ad hoc request logging
  - a contract daemon should start from the shared package or canonical module, then validate tests and handler wiring

Use daemons for mushy but important review surfaces such as:

- documentation that should stay current with the actual repo surface
- consistency across microservices, such as shared middleware, health behavior, or instrumentation patterns
- operator workflows and conventions that should stay aligned across scripts, docs, and entrypoints

Do not use daemons for checks that should be a linter, typechecker, or unit test.

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

Simple job: <plain-English one-line summary of the daemon's job>.

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
- explicit about what it does not own
- specific about source-of-truth files
- explicit about the highest-value mismatch classes
- short enough that the daemon does not waste tokens on restated protocol

Bad daemon body:

- repeats how `track` works
- repeats how `complete` works
- tells the daemon to audit the whole repo without a narrow authority order
- mixes docs drift, topology drift, and layering drift without explicit out-of-scope exclusions
- mixes universal runner behavior with domain-specific guidance
