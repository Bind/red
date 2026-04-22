/**
 * Unified triage workflow: investigate → human approval gate → propose.
 *
 * Each phase is a ReviewLoop-shaped drafter→reviewer iteration
 * (https://smithers.sh/guides/review-loop). The Approval node between
 * them pauses the workflow in `waiting-approval` state until
 *   POST /v1/runs/:runId/nodes/human-gate/approve
 * is called on the Smithers server.
 *
 * Input JSON (via POST /v1/runs):
 *   { rollup: WideRollupRecord }
 *
 * Final outputs live in SQLite tables:
 *   triage_plan       (last row for node "draft")
 *   triage_proposal   (last row for node "implement")
 */

import {
	approvalDecisionSchema,
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
import { createTriageAgent } from "./agents";

const MAX_REVIEW_ROUNDS = 3;

const {
	Workflow,
	Task,
	Approval,
	smithers,
	tables,
	outputs,
	useCtx,
} = createSmithers({
	rollup: WideRollupRecordSchema,
	triagePlan: TriagePlanSchema,
	review: ReviewSchema,
	reviewFix: ReviewFixSchema,
	validate: ValidateSchema,
	humanGate: approvalDecisionSchema,
	triageProposal: TriageProposalSchema,
});

const triageAgent = createTriageAgent();

function InvestigateDraft() {
	const ctx = useCtx();
	const lastReview = ctx.latest(tables.review, "investigate-review");
	const lastPlan = ctx.latest(tables.triagePlan, "draft");
	return (
		<Task id="draft" output={outputs.triagePlan} agent={triageAgent}>
			{`Triage this 5xx error rollup and produce a TriagePlan.
Previous plan (if any): ${lastPlan ? JSON.stringify(lastPlan) : "none"}
Issues to address:     ${
				lastReview && !lastReview.approved
					? JSON.stringify(lastReview.issues)
					: "none"
			}

Do NOT write code. Set confidence honestly.`}
		</Task>
	);
}

function InvestigateReview() {
	const ctx = useCtx();
	const plan = ctx.latest(tables.triagePlan, "draft");
	if (!plan) return null;
	return (
		<Task id="investigate-review" output={outputs.review} agent={triageAgent}>
			{`Critique this TriagePlan. approved=true only if hypothesis names a
specific symbol, suspected_files are real paths, proposed_change_summary is
scoped, and confidence is justified. Otherwise return structured issues.

${JSON.stringify(plan, null, 2)}`}
		</Task>
	);
}

function InvestigateReviewFix() {
	const ctx = useCtx();
	const review = ctx.latest(tables.review, "investigate-review");
	const skip = !review || review.approved || review.issues.length === 0;
	return (
		<Task
			id="investigate-review-fix"
			output={outputs.reviewFix}
			agent={triageAgent}
			skipIf={skip}
		>
			{`Rewrite the plan to resolve every issue:
${JSON.stringify(review?.issues ?? [], null, 2)}

Feedback: ${review?.feedback ?? ""}`}
		</Task>
	);
}

function InvestigateLoop() {
	const ctx = useCtx();
	const review = ctx.latest(tables.review, "investigate-review");
	return (
		<Loop
			id="investigate-loop"
			until={!!review?.approved}
			maxIterations={MAX_REVIEW_ROUNDS}
			onMaxReached="return-last"
		>
			<Sequence>
				<InvestigateDraft />
				<InvestigateReview />
				<InvestigateReviewFix />
			</Sequence>
		</Loop>
	);
}

function HumanGate() {
	const ctx = useCtx();
	const plan = ctx.latest(tables.triagePlan, "draft");
	return (
		<Approval
			id="human-gate"
			output={outputs.humanGate}
			mode="approve"
			request={{
				title: `Approve triage plan${plan?.hypothesis ? `: ${plan.hypothesis}` : ""}`,
			}}
		/>
	);
}

function ProposeImplement() {
	const ctx = useCtx();
	const plan = ctx.latest(tables.triagePlan, "draft");
	const lastValidate = ctx.latest(tables.validate, "validate");
	const lastReview = ctx.latest(tables.review, "propose-review");
	return (
		<Task
			id="implement"
			output={outputs.triageProposal}
			agent={triageAgent}
			timeoutMs={30 * 60 * 1000}
		>
			{`Implement the approved plan:
${JSON.stringify(plan, null, 2)}

1. Create branch triage/<request_id>
2. Make the smallest change that addresses the hypothesis
3. Push through grs (remote SDK, no local git)
4. Open a PR, capture the URL

Previous iteration:
  validate: ${lastValidate ? JSON.stringify(lastValidate) : "none"}
  review:   ${
				lastReview && !lastReview.approved
					? JSON.stringify(lastReview.issues)
					: "none"
			}

Return TriageProposal { repo_id, branch, pr_url, summary }.`}
		</Task>
	);
}

function ProposeValidate() {
	return (
		<Task
			id="validate"
			output={outputs.validate}
			agent={triageAgent}
			timeoutMs={10 * 60 * 1000}
		>
			{`Run the affected package's tests and typecheck. Report all_passed and
failing_summary. Do not modify files.`}
		</Task>
	);
}

function ProposeReview() {
	const ctx = useCtx();
	const proposal = ctx.latest(tables.triageProposal, "implement");
	const validate = ctx.latest(tables.validate, "validate");
	if (!proposal || !validate?.all_passed) return null;
	return (
		<Task id="propose-review" output={outputs.review} agent={triageAgent}>
			{`Review the diff on branch ${proposal.branch}. approved=true only if
the change is scoped to the plan, matches proposed_change_summary, leaves no
dead code / TODOs, and tests pass.

${JSON.stringify(proposal, null, 2)}`}
		</Task>
	);
}

function ProposeReviewFix() {
	const ctx = useCtx();
	const review = ctx.latest(tables.review, "propose-review");
	const skip = !review || review.approved || review.issues.length === 0;
	return (
		<Task
			id="propose-review-fix"
			output={outputs.reviewFix}
			agent={triageAgent}
			skipIf={skip}
		>
			{`Resolve every review issue. No scope creep.
${JSON.stringify(review?.issues ?? [], null, 2)}

Feedback: ${review?.feedback ?? ""}`}
		</Task>
	);
}

function ProposeLoop() {
	const ctx = useCtx();
	const review = ctx.latest(tables.review, "propose-review");
	const validate = ctx.latest(tables.validate, "validate");
	return (
		<Loop
			id="propose-loop"
			until={!!review?.approved && !!validate?.all_passed}
			maxIterations={MAX_REVIEW_ROUNDS}
			onMaxReached="fail"
		>
			<Sequence>
				<ProposeImplement />
				<ProposeValidate />
				<ProposeReview />
				<ProposeReviewFix />
			</Sequence>
		</Loop>
	);
}

export default smithers(() => (
	<Workflow name="redc.triage">
		<Sequence>
			<InvestigateLoop />
			<HumanGate />
			<ProposeLoop />
		</Sequence>
	</Workflow>
));
