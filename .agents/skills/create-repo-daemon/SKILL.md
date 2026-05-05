---
name: create-repo-daemon
description: Full lifecycle for repo daemons — create, seed memory, run, and refine via interactive resume. Use when adding a new `*.daemon.md` audit agent, tightening an existing one, seeding a daemon's initial memory with tracked facts from authority files, or verifying a new daemon reasons correctly before CI rotation.
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

### Phase 1 — Define ownership and write the daemon file

1. Find the ownership boundary.

- Choose the narrowest folder or repo surface the daemon should own.
- Prefer placing the daemon file inside the owned subtree when the audit is local.
- Use the daemon filename as the stable audit identity, e.g. `infra-audit.daemon.md`.

2. Decide whether the subtree needs an `AGENTS.md`.

- Add `AGENTS.md` when the daemon audits a folder with local patterns, invariants, or reading order that another agent would not know.
- Skip `AGENTS.md` when the daemon can be anchored by obvious repo-wide contracts and a small daemon body.

3. Write the daemon body as a responsibility statement plus domain guidance.

- Start with a one-line "Simple job:" description in very plain English before the detailed guidance.
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

### Phase 2 — Design trackable subjects before the first run

Before running the daemon, ask the operator the following questions to surface what's worth tracking:

**Ask:** "What are the 2-4 most stable authority files this daemon should always know about — files that rarely change but everything else depends on?"

Good answers: a root README, a shared package's `index.ts`, a canonical compose file, a schema definition, a CLI entrypoint. Bad answers: generated files, lock files, anything that changes on every PR.

**Ask:** "What are the 1-3 key invariants this daemon should be able to verify without re-reading the whole scope?"

Examples: "every app exports a health endpoint", "every route in the API has a matching entry in the docs", "all services use the shared logger, not console.log".

**Ask:** "Which files or directories are explicitly out of scope — things that look related but the daemon should never touch?"

Record these answers. Use them to write the seeding input in Phase 3.

Good trackable subjects have these properties:
- **Stable name**: matches a real file path, module name, or invariant tag (e.g. `apps/auth/src/index.ts`, `shared_logger_contract`, `api_route_docs_alignment`)
- **Compact fact**: a short JSON object or string, not a narrative paragraph
- **Precise `depends_on`**: lists the exact file paths or subjects the fact was derived from, so the runner can detect when the fact is stale
- **One subject per stable claim**: don't bundle three invariants into one tracked entry

Bad trackable subjects:
- Subjects that change every PR (generated output, timestamps, version numbers)
- Subjects with no `depends_on` (runner can't tell when they're stale)
- Large blob facts (over ~1KB) — prefer a pointer or a structured summary

### Phase 3 — Seed memory directly

Do not run the daemon to seed its memory. Instead, read the authority files yourself and write tracked facts directly using the `seed-memory.ts` script bundled with this skill.

**For each subject identified in Phase 2:**

1. Use the `Read` tool to open the authority file.
2. Extract the compact fact — the specific claim the daemon needs to remember.
3. Call `seed-memory.ts` to write it into the daemon's memory store:

```bash
bun run .agents/skills/create-repo-daemon/seed-memory.ts \
  <daemon-name> \
  --subject <subject> \
  --fact '<json>' \
  --depends-on <path-relative-to-scopeRoot>
```

Run this from the repo root. `--depends-on` may be repeated for multiple files.

**Example for a docs daemon** (scopeRoot = repo root, daemon file at `docs-command-surface.daemon.md`):

```bash
# After reading README.md and extracting the command list:
bun run .agents/skills/create-repo-daemon/seed-memory.ts docs-command-surface \
  --subject root_readme_cli_commands \
  --fact '{"commands":["status","help"]}' \
  --depends-on README.md

# After reading scripts/red:
bun run .agents/skills/create-repo-daemon/seed-memory.ts docs-command-surface \
  --subject scripts_red_commands \
  --fact '{"commands":["bureau run","bureau resume","bureau daemon"]}' \
  --depends-on scripts/red
```

**Fact shape guidance** — keep facts compact and structured:

```json
// Good: a specific enumerable claim with stable keys
{"commands": ["status", "help"]}
{"exports": ["createPiProvider", "loadDaemons"]}
{"endpoints": ["/health", "/api/reviews"]}

// Bad: narrative text
{"note": "The README describes the CLI surface and mentions status and help commands"}

// Bad: large blob
{"full_file_contents": "..."}
```

The fingerprint is auto-computed from the `--depends-on` file contents. If those files are unchanged on the next daemon run, the tracked fact will be reused without re-reading.

### Phase 4 — Run the daemon via the executor

With memory seeded, run the daemon through the bureau runtime for its first audit pass:

```bash
just bureau daemon <daemon-name>
```

This resolves the daemon by name, loads the seeded memory, builds the system prompt, and executes through the bureau runtime. The daemon will call `track.lookup` early, find the subjects you seeded, and proceed directly to auditing without re-reading authority files from scratch.

**What to watch for:**

- The daemon should call `track.lookup` in turn 1 and find your seeded subjects — if it doesn't, the subject names or daemon name may not match
- Turn count should stay low (under the daemon's `max_turns` budget) because the memory shortcut works
- The `complete` summary should reference cached facts rather than "I read X and found Y"

**Signs memory needs work:**
- The daemon ignores tracked facts and re-reads every file — tracked subjects need tighter `depends_on` coverage or more precise subject names
- Tracked facts are long narrative paragraphs — compress them to structured JSON
- No `depends_on` set — the runner can't detect staleness so facts are never reused confidently

If the first run surfaces real findings, that is correct behavior — seeding memory does not suppress violations, it only eliminates redundant reads.

### Phase 5 — Chat with the daemon via resume

After the executor run completes, continue the session interactively to ask follow-up questions, request clarification on findings, or steer the next audit focus:

```bash
just bureau resume
```

Pick the session from the fzf picker. The session carries the full conversation history — the daemon remembers everything it read and concluded in the first run.

Useful follow-up prompts:
- "Which files did you not check that are in scope?"
- "The finding on `<file>` — what exactly was the mismatch?"
- "Record a tracked fact for `<subject>` so you don't need to re-read it next time."
- "What would you check first if `<authority-file>` changed?"

This resume loop is how you refine a new daemon before it enters CI rotation — you can steer its attention, fill gaps in memory, and verify it reasons correctly before it runs unsupervised.

---

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
