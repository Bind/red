/**
 * Phase 1 workflow: investigate a 5xx error rollup and produce a reviewed plan.
 *
 * Shape follows https://smithers.sh/guides/review-loop — a Loop wrapping a
 * Sequence of Draft → Review → (Fix if issues). No code is generated in this
 * phase; the human approval gate between investigate and propose lives in the
 * redc-triage HTTP service.
 *
 * Input JSON (passed via `smithers up investigate.tsx -i '<json>'`):
 *   { rollup: WideRollupRecord }
 *
 * Final output: the last `triagePlan` row in SQLite, reachable via
 *   ctx.latest(tables.triagePlan, "draft")
 * after the workflow exits.
 */

import {
	ClaudeCodeAgent,
	createSmithers,
	Loop,
	Sequence,
} from "smithers-orchestrator";
import {
	ReviewFixSchema,
	ReviewSchema,
	TriagePlanSchema,
	WideRollupRecordSchema,
} from "../types";

const MAX_REVIEW_ROUNDS = 3;

const { Workflow, Task, smithers, tables, outputs, useCtx } = createSmithers({
	rollup: WideRollupRecordSchema,
	triagePlan: TriagePlanSchema,
	review: ReviewSchema,
	reviewFix: ReviewFixSchema,
});

const claude = new ClaudeCodeAgent({
	permissionMode: "plan",
	model: process.env.TRIAGE_MODEL ?? undefined,
});

function Draft() {
	const ctx = useCtx();
	const lastReview = ctx.latest(tables.review, "review");
	const lastPlan = ctx.latest(tables.triagePlan, "draft");

	return (
		<Task id="draft" output={outputs.triagePlan} agent={claude}>
			{`You are triaging a 5xx error in the redc codebase.
Inputs available in context:
  - rollup (wide-event rollup)
  - previous plan (if any): ${lastPlan ? JSON.stringify(lastPlan) : "none"}
  - review issues to address: ${
		lastReview && !lastReview.approved
			? JSON.stringify(lastReview.issues)
			: "none"
	}

Produce a TriagePlan with:
  - hypothesis: concrete root-cause hypothesis naming the responsible function/module
  - suspected_files: relative paths you would inspect first
  - reproduction_steps: how to reproduce this request locally
  - proposed_change_summary: one paragraph describing the smallest viable fix
  - confidence: low | medium | high

Do NOT write code. Do NOT touch files. This is a plan only.`}
		</Task>
	);
}

function Review() {
	const ctx = useCtx();
	const plan = ctx.latest(tables.triagePlan, "draft");
	if (!plan) return null;

	return (
		<Task id="review" output={outputs.review} agent={claude}>
			{`Critique the following TriagePlan. Set approved=true ONLY if:
  - hypothesis names a specific symbol/function
  - suspected_files contain real paths (not placeholders)
  - proposed_change_summary describes a concrete, scoped fix
  - confidence is justified by the evidence

Otherwise, return structured issues with severity and a concise feedback blurb.

Plan under review:
${JSON.stringify(plan, null, 2)}`}
		</Task>
	);
}

function ReviewFix() {
	const ctx = useCtx();
	const review = ctx.latest(tables.review, "review");
	const allApproved = !!review?.approved;
	const hasIssues = (review?.issues?.length ?? 0) > 0;

	return (
		<Task
			id="review-fix"
			output={outputs.reviewFix}
			agent={claude}
			skipIf={allApproved || !hasIssues}
		>
			{`Rewrite the TriagePlan to resolve every review issue below, then confirm
which fixes were applied. The next Draft iteration will read your fixes.

Issues:
${JSON.stringify(review?.issues ?? [], null, 2)}

Feedback:
${review?.feedback ?? ""}`}
		</Task>
	);
}

function ReviewLoop() {
	const ctx = useCtx();
	const review = ctx.latest(tables.review, "review");
	const approved = !!review?.approved;

	return (
		<Loop
			id="investigate-review-loop"
			until={approved}
			maxIterations={MAX_REVIEW_ROUNDS}
			onMaxReached="return-last"
		>
			<Sequence>
				<Draft />
				<Review />
				<ReviewFix />
			</Sequence>
		</Loop>
	);
}

export default smithers(() => (
	<Workflow name="redc.triage.investigate">
		<ReviewLoop />
	</Workflow>
));
