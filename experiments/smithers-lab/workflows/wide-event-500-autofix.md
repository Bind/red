# Wide-Event 500 Autofix

First-pass Smithers workflow spec for red.

## Goal

When a root wide-event request terminates with `status_code >= 500`, trigger a Smithers workflow that:

1. diagnoses the failure
2. decides whether the failure is patchable
3. proposes the smallest safe code or config fix
4. opens a PR in red forge when confidence and policy gates are satisfied

This workflow is for recurring, actionable regressions. It should diagnose every qualifying 500, but it should only open a PR for high-confidence failures with a clear owner and a bounded fix.

## Non-Goals

- replacing incident response for infra-wide outages
- opening PRs for one-off flakes
- auto-merging fixes
- guessing repo ownership when the target is ambiguous
- treating propagated child errors as canonical root failures

## Trigger

Trigger source: canonical wide-event rollup pipeline.

Required trigger conditions:

- request is a root request
- request has reached a terminal state
- `status_code >= 500`
- a dedupe fingerprint is available

Recommended rate gates before implementation begins:

- same fingerprint seen at least `3` times in `15m`, or
- same fingerprint seen `1` time with `severity = critical`

Recommended no-op gates:

- skip if a remediation PR is already open for the same fingerprint
- skip if the fingerprint maps to a known infra incident
- skip if the request is already attributed to an upstream outage

## Input Schema

```ts
const autofixTriggerSchema = z.object({
  requestId: z.string(),
  parentRequestId: z.string().optional(),
  isRootRequest: z.boolean(),
  service: z.string(),
  route: z.string(),
  method: z.string(),
  statusCode: z.number().int(),
  requestState: z.enum(["completed", "error", "incomplete"]),
  rolledUpAt: z.string(),
  rollupReason: z.enum(["terminal_event", "timeout"]),
  errorMessage: z.string().optional(),
  fingerprint: z.string(),
  occurrenceCount: z.number().int(),
  windowMinutes: z.number().int(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  changeId: z.string().optional(),
  runId: z.string().optional(),
  actor: z.string().optional(),
});
```

## Output Schemas

### Diagnosis

```ts
const diagnosisSchema = z.object({
  failureClass: z.enum([
    "app_regression",
    "config_regression",
    "observability_bug",
    "dependency_outage",
    "infra_transient",
    "unknown",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  suspectedOwner: z.string().optional(),
  targetRepo: z.string().optional(),
  targetArea: z.string().optional(),
  rootCause: z.string(),
  evidence: z.array(z.string()).min(1),
});
```

### Repair Plan

```ts
const repairPlanSchema = z.object({
  shouldAttemptFix: z.boolean(),
  reason: z.string(),
  patchType: z.enum([
    "code",
    "config",
    "test_only",
    "observability",
    "none",
  ]),
  targetRepo: z.string().optional(),
  targetBranch: z.string().optional(),
  filesLikelyInScope: z.array(z.string()),
  testPlan: z.array(z.string()),
  implementationPrompt: z.string().optional(),
});
```

### Review Verdict

```ts
const reviewVerdictSchema = z.object({
  approvedForPr: z.boolean(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  blockingConcerns: z.array(z.string()),
  requiredFollowups: z.array(z.string()),
});
```

### PR Result

```ts
const prResultSchema = z.object({
  opened: z.boolean(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  prNumber: z.string().optional(),
  prUrl: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  skippedReason: z.string().optional(),
});
```

## Workflow Graph

The intended Smithers shape is parallel specialists followed by a hard aggregation gate.

```text
trigger
  -> Parallel
     -> classify-incident
     -> collect-wide-event-evidence
     -> collect-red-context
  -> aggregate-diagnosis
  -> branch: attempt fix?
     -> implement-fix
     -> review-fix
     -> branch: open PR?
        -> open-red-forge-pr
```

## Task Definitions

### `classify-incident`

Purpose:
- classify the 500 into a repair category
- separate patchable app/config regressions from infra noise

Inputs:
- trigger payload
- normalized error details
- recent fingerprint history

Output:
- `diagnosisSchema` candidate with initial confidence

Prompt responsibilities:
- decide whether the failure is code, config, observability, dependency, infra, or unknown
- name the smallest plausible owner
- explain the classification in operational terms, not generic prose

### `collect-wide-event-evidence`

Purpose:
- gather the concrete evidence Smithers needs to reason about the failure

Inputs:
- `request_id`
- fingerprint

Expected integrations:
- canonical rollup lookup
- raw wide-event lookup by `request_id`
- sibling rollups with same fingerprint

Output:
- structured evidence bundle consumed by the aggregator

Evidence to collect:
- root vs propagated status
- rollup reason
- services touched
- terminal event details
- timing and retries
- whether downstream services are missing from the final rollup

### `collect-red-context`

Purpose:
- map the failure to red ownership and current change activity

Expected integrations:
- recent red runs
- related change or branch
- repo metadata
- existing open remediation PRs

Output:
- repo, branch, change, suspected owner, active PR collisions

### `aggregate-diagnosis`

Purpose:
- synthesize the classifiers and evidence into the canonical diagnosis

Rules:
- if evidence indicates infra or dependency outage, do not attempt a fix PR
- if no target repo can be identified, do not attempt a fix PR
- if the fingerprint does not recur and severity is below critical, diagnose only
- if confidence is below threshold, diagnose only

Recommended PR threshold:
- `confidence >= 0.80`

Recommended implementation threshold:
- `confidence >= 0.70`

### `implement-fix`

Purpose:
- create the smallest patch likely to resolve the failure

Preconditions:
- `repairPlan.shouldAttemptFix === true`
- target repo is unambiguous
- no already-open PR for this fingerprint

Expected behavior:
- create a branch in the owning repo
- make bounded edits
- add or strengthen a reproducing test where practical
- keep changes scoped to the diagnosed failure mode

Expected outputs:
- changed files
- test results
- implementation summary

### `review-fix`

Purpose:
- independently review whether the patch actually addresses the observed 500

Review dimensions:
- does the patch align with the failure evidence?
- does it reduce regression risk?
- is the test plan sufficient?
- are there hidden rollout or config hazards?

This is the hard gate before opening a PR.

### `open-red-forge-pr`

Purpose:
- open a remediation PR in red forge with complete incident context

Only runs when:
- `reviewVerdict.approvedForPr === true`
- repo and branch are known
- no duplicate remediation PR exists

## Approval and Safety Policy

The system should diagnose automatically but PR creation should be policy-gated.

Minimum conditions for opening a PR:

- root request
- recurring fingerprint or critical severity
- not classified as infra or dependency outage
- repo owner identified
- proposed fix is bounded
- reviewer approved
- branch and PR destination known

Strongly recommended extra gate:

- require a human approval step before PR creation for the first rollout of this workflow

## Fingerprint Design

The fingerprint should be stable enough to dedupe recurring failures without collapsing unrelated bugs.

Recommended fields:

- service
- normalized route
- status code family
- error class or normalized top stack frame
- optional deploy SHA or app version

Avoid using:

- full raw stack trace
- full error string with IDs or timestamps
- request ID

## Required Integrations

### Wide Events

- read canonical rollups
- read raw events by `request_id`
- inspect root/child propagation details

### Red Forge

- find repo by service ownership
- create branch
- commit patch
- open PR
- search for duplicate open PRs

### red Runtime Context

- look up related change IDs
- inspect recent agent runs
- inspect current branch activity

## PR Template

Suggested PR title:

```text
autofix(<service>): remediate recurring 500 on <route>
```

Suggested PR body:

```md
## Why

Smithers detected recurring `>=500` failures for:

- service: `<service>`
- route: `<route>`
- fingerprint: `<fingerprint>`
- example request_id: `<request_id>`

## Diagnosis

`<summary>`

Failure class: `<failureClass>`
Confidence: `<confidence>`

## Evidence

- `<evidence line 1>`
- `<evidence line 2>`
- `<evidence line 3>`

## Change

`<implementation summary>`

## Verification

- `<test/result 1>`
- `<test/result 2>`

## Risks

- `<risk 1>`
- `<risk 2>`
```

## Failure Modes to Handle Explicitly

- root rollup exists but raw events are incomplete
- child service emitted terminal error but root request eventually succeeded
- duplicate PRs for the same fingerprint
- target repo cannot be inferred
- proposed patch passes local checks but does not actually address the failure signature
- wide-event propagation is itself the bug

## Recommended Build Order

1. Diagnose only: emit diagnosis artifacts with no patching
2. Add repo ownership mapping and duplicate-PR checks
3. Add implementation step behind a feature flag
4. Add review gate
5. Add PR creation behind human approval
6. Relax toward automatic PR opening only after observing stable precision

## First Implementation Slice

The smallest credible first version is:

- trigger from canonical rollups on recurring root `>=500`
- classify and gather evidence
- produce a structured diagnosis artifact
- create a draft remediation plan
- stop before code changes

That gives operational value immediately and builds the dataset needed to decide whether the auto-PR step is actually safe.
