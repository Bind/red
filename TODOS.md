# TODOS

## Post-MVP

### Post-summary reclassification
**What:** After LLM summary completes, compare its risk assessment to the static confidence score. If they disagree (static says "safe" but LLM flags risk), escalate the change and update the Forgejo status check.
**Why:** Static signals (file paths, diff size) are weak proxies. The LLM reads actual code and may catch risk that file-level heuristics miss. Without reclassification, a "safe" status check could remain even when the LLM summary says "this touches auth logic."
**Context:** The fast path (webhook → scoring → status check) runs synchronously. The slow path (LLM summary) runs async via job queue. By the time the summary arrives, the status check is already posted. Reclassification means: read summary risk assessment, compare to stored score, update Forgejo status check if escalation needed.
**Depends on:** Phase 3 (LLM summaries) must be complete first.
**Effort:** ~40 lines in summary completion handler.

### Trust scoring + agent identity
**What:** Distinct `user_type: agent` flag, per-agent trust scores based on historical merge rate and policy compliance.
**Why:** Core differentiator for "agent-native" forge. Without it, agents are just regular users with no behavioral tracking.
**Context:** Deferred because trust scoring requires historical data (merge outcomes) that won't exist until the product has usage. The `created_by` field on changes (agent vs human flag) captures the minimal signal for now. Full trust scoring needs: score algorithm, decay strategy, threshold calibration, and integration into confidence scoring weights.
**Depends on:** Enough usage data to calibrate scores (at least 2-4 weeks of real merges).
**Effort:** ~200 lines across engine/review.ts, db/schema.ts, and a new engine/trust.ts module.

### Dashboard UI
**What:** Web dashboard for the review queue. "What should I look at right now?" view sorted by risk and urgency.
**Why:** The CLI is sufficient for dogfooding but external users will expect a visual interface.
**Context:** Decided during eng review to start API-only with minimal CLI. Forgejo's native UI serves as temporary human surface. Custom dashboard replaces Forgejo UI as part of the long-term vision to own the full stack.
**Depends on:** API routes stable, CLI dogfooding validates the workflow.

### Import from GitHub
**What:** `redc import github.com/org/repo` CLI command that clones repo + history and reconfigures remotes.
**Why:** Teams evaluating redc won't abandon existing repos. Import is the bridge from evaluation to adoption.
**Context:** Identified in design doc as Phase 2 deliverable.
**Depends on:** Push-to-create working, Forgejo API repo management stable.

### Idempotent job retries (stuck-in-scoring bug)
**What:** When a `score_change` job fails mid-way (e.g., Forgejo API timeout after transitioning to `scoring`), the retry attempts `stateMachine.transition(change_id, 'scoring')` which throws `InvalidTransitionError` because the change is already in `scoring`. The change is permanently stuck with no recovery path.
**Why:** Any Forgejo API failure during scoring = permanently stuck change. The job retries but every retry immediately fails on the transition check.
**Context:** Fix is straightforward: check current status before transitioning. If already in the target state, skip the transition. Same pattern needed in `handleGenerateSummary` for the `summarizing` state. This is the standard idempotent-retry pattern.
**Depends on:** Nothing — can fix anytime.
**Effort:** ~10 lines in worker.ts (handleScoreChange + handleGenerateSummary).

### Auto PR creation
**What:** After scoring a change, automatically create a Forgejo PR (base_branch → feature branch) and store `pr_number` on the change record.
**Why:** Without a PR, the merge path is broken — `forgejo.mergePR()` has nothing to merge, and humans can't see changes in Forgejo's PR list. The change sits in `ready_for_review` with `pr_number: null`.
**Context:** The design doc says agents push to feature branches and redc auto-creates PRs for review. Currently there's no PR creation step anywhere in the pipeline. Fix: add a `createPR` method to ForgejoClient, call it in handleScoreChange after scoring. Forgejo API: `POST /repos/{owner}/{repo}/pulls` with `{head: branch, base: base_branch, title: summary}`.
**Depends on:** ForgejoClient method addition (~10 lines), worker.ts integration (~10 lines).
**Effort:** ~20 lines total.

### Force-push handling
**What:** When a force-push rewrites history on a branch that already has a scored change, the existing Forgejo commit status on the old SHA becomes stale — it shows a passing check on a commit that no longer exists in the branch.
**Why:** Force-pushes are common in agent workflows (rebasing onto updated main). Stale statuses on dead commits could confuse reviewers or allow merges based on outdated scoring.
**Context:** The supersession logic correctly marks prior changes as superseded when a new push arrives on the same branch. But the old commit status in Forgejo isn't cleaned up. Fix: when superseding, also set the old commit's status to "error" or "cancelled" with a description like "superseded by newer push."
**Depends on:** Nothing — can fix anytime.
**Effort:** ~10 lines in the supersession path.

### Self-hosted deployment
**What:** Docker image + Helm chart for on-prem deployment.
**Why:** Security-conscious teams (finance, healthcare, gov) need self-hosted.
**Context:** SaaS deployment via SST (AWS ECS/Fargate) is implemented. Dockerfile exists. Self-hosted (Helm chart, operational docs) still needed for on-prem.
**Depends on:** SaaS version stable, at least one paying customer validating the product.
