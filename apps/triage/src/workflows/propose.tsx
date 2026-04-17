/**
 * Phase 2 workflow: implement the approved plan, validate, review, fix.
 *
 * Shape follows https://smithers.sh/guides/review-loop — implement → validate
 * → review → review-fix inside a Loop until both approvals land or maxIterations
 * is reached. The human approval gate guarding this phase sits in the
 * redc-triage HTTP service; this workflow only runs after the human approves.
 *
 * Input JSON:
 *   { rollup: WideRollupRecord, plan: TriagePlan }
 *
 * Final output: the last `triageProposal` row in SQLite, reachable via
 *   ctx.latest(tables.triageProposal, "implement")
 * after the workflow exits.
 */

import {
	AnthropicAgent,
	createSmithers,
	Loop,
	Sequence,
} from "smithers-orchestrator";
import {
	ReviewFixSchema,
	ReviewSchema,
	TriagePlanSchema,
	TriageProposalSchema,
	ValidateSchema,
	WideRollupRecordSchema,
} from "../types";

const MAX_REVIEW_ROUNDS = 3;

const { Workflow, Task, smithers, tables, outputs, useCtx } = createSmithers({
	rollup: WideRollupRecordSchema,
	plan: TriagePlanSchema,
	triageProposal: TriageProposalSchema,
	validate: ValidateSchema,
	review: ReviewSchema,
	reviewFix: ReviewFixSchema,
});

const claude = new AnthropicAgent({
	model: process.env.TRIAGE_MODEL ?? "claude-sonnet-4-6",
});

function Implement() {
	const ctx = useCtx();
	const lastValidate = ctx.latest(tables.validate, "validate");
	const lastReview = ctx.latest(tables.review, "review");
	const plan = ctx.latest(tables.plan, "plan");

	return (
		<Task
			id="implement"
			output={outputs.triageProposal}
			agent={claude}
			timeoutMs={30 * 60 * 1000}
		>
			{`Implement the approved plan:
${JSON.stringify(plan, null, 2)}

Workflow:
  1. Create a branch named triage/<request_id>.
  2. Make the smallest change that addresses the hypothesis — do not touch unrelated files.
  3. Push the branch through the grs git server (use the Bash tool with the remote SDK; do not shell to local git).
  4. Open a pull request and capture its URL.

Previous iteration feedback:
  - validation result: ${lastValidate ? JSON.stringify(lastValidate) : "none"}
  - review issues:     ${
		lastReview && !lastReview.approved
			? JSON.stringify(lastReview.issues)
			: "none"
	}

Return a TriageProposal with repo_id, branch, pr_url, and a summary of the change.`}
		</Task>
	);
}

function Validate() {
	return (
		<Task
			id="validate"
			output={outputs.validate}
			agent={claude}
			timeoutMs={10 * 60 * 1000}
		>
			{`Run the affected package's tests and typecheck. If any fail, set
all_passed=false and summarize the failures in failing_summary.
Do not modify any files in this task — only run tools.`}
		</Task>
	);
}

function Review() {
	const ctx = useCtx();
	const proposal = ctx.latest(tables.triageProposal, "implement");
	const validate = ctx.latest(tables.validate, "validate");
	if (!proposal || !validate?.all_passed) return null;

	return (
		<Task id="review" output={outputs.review} agent={claude}>
			{`Review the diff introduced on branch ${proposal.branch}. Set approved=true ONLY if:
  - the change is scoped to the files named in the plan
  - the change matches proposed_change_summary
  - no dead code, placeholders, or TODOs remain
  - tests pass (validation already confirmed this)

Otherwise return structured issues.

Proposal:
${JSON.stringify(proposal, null, 2)}`}
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
			{`Apply fixes for every review issue below. Do not introduce scope creep.

Issues:
${JSON.stringify(review?.issues ?? [], null, 2)}

Feedback:
${review?.feedback ?? ""}`}
		</Task>
	);
}

function ImplementReviewLoop() {
	const ctx = useCtx();
	const review = ctx.latest(tables.review, "review");
	const validate = ctx.latest(tables.validate, "validate");
	const done = !!review?.approved && !!validate?.all_passed;

	return (
		<Loop
			id="propose-review-loop"
			until={done}
			maxIterations={MAX_REVIEW_ROUNDS}
			onMaxReached="fail"
		>
			<Sequence>
				<Implement />
				<Validate />
				<Review />
				<ReviewFix />
			</Sequence>
		</Loop>
	);
}

export default smithers(() => (
	<Workflow name="redc.triage.propose">
		<ImplementReviewLoop />
	</Workflow>
));
