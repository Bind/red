import {
	CodexAgent,
	createSmithers,
	Loop,
	Sequence,
} from "smithers-orchestrator";
import {
	DiffAnalysisSchema,
	FindingsReportSchema,
	PatternReviewInputSchema,
	ReviewSchema,
} from "./types";

const MAX_REVIEW_ROUNDS = 2;

const { Workflow, Task, smithers, tables, outputs, useCtx } = createSmithers(
	{
		input: PatternReviewInputSchema,
		diffAnalysis: DiffAnalysisSchema,
		findingsReport: FindingsReportSchema,
		review: ReviewSchema,
	},
	{
		dbPath: process.env.PR_PATTERN_REVIEW_DB_PATH ?? "./smithers.db",
	},
);

const reviewer = new CodexAgent({
	model: process.env.PR_PATTERN_REVIEW_SUBSCRIPTION_MODEL ?? "gpt-5.3-codex",
	sandbox: "danger-full-access",
	fullAuto: true,
	config: {
		model_reasoning_effort:
			process.env.PR_PATTERN_REVIEW_SUBSCRIPTION_REASONING_EFFORT ?? "high",
	},
	timeoutMs: 30 * 60 * 1000,
});

function Analyze() {
	const ctx = useCtx();
	const input = ctx.latest(tables.input, "input");
	const filesList =
		input?.diff.files.map((f: { path: string }) => f.path).join(", ") ?? "";
	return (
		<Task id="analyze-diff" output={outputs.diffAnalysis} agent={reviewer}>
			{`Summarize this PR for a repo-pattern reviewer.

Focus on whether the change touches:
- infrastructure / IaC / deploy topology
- local developer entrypoints and hot-reload flow
- env contracts and bootstrap paths
- CI / preview / release parity

PR #${input?.pr.number}: ${input?.pr.title}
Files changed: ${filesList}

Return concise fields only.`}
		</Task>
	);
}

function FindFindings() {
	const ctx = useCtx();
	const input = ctx.latest(tables.input, "input");
	const lastReview = ctx.latest(tables.review, "verify-findings");
	return (
		<Task
			id="find-findings"
			output={outputs.findingsReport}
			agent={reviewer}
			timeoutMs={10 * 60 * 1000}
		>
			{`Review this PR for violations of established redc repository patterns.

Only report concrete violations that are evidenced by the diff plus the provided
repo context. Do not suggest optional refactors. If a touched area is
consistent with the existing repo pattern, do not comment on it.

Primary rules to enforce:
1. \`just\` is the operator interface for local/dev/release flows.
   If a PR introduces new repo instructions or CI/deploy entrypoints that
   should be reachable through \`just\`, flag missing or bypassed recipes.
2. Local dev should keep a fresh-build path and a hot-reload path. Changes to
   Docker/build/bootstrap flow should preserve \`just up\` as the fresh-build
   stack bring-up and avoid breaking bind-mounted watch/dev commands.
3. Infra/IaC changes should keep the repo's deploy paths coherent. If a PR
   changes compose/SST/deploy/image/env contracts, flag missing companion
   updates in preview/release workflows, bootstrap scripts, or env templates
   when the diff clearly requires them.
4. Changes to env names or required runtime secrets should update the relevant
   \`.env.*\` templates and any consuming scripts/workflows touched by that path.
5. Preview/prod/dev behavior should not silently diverge in touched areas
   without an explicit reason encoded in the diff.

PR diff:
${JSON.stringify(input?.diff.files ?? [], null, 2)}

Relevant repo context files:
${JSON.stringify(input?.context_files ?? [], null, 2)}

For each real issue return:
- file_path, file_line on the changed file to anchor the comment
- severity: critical | major | minor | nit
- rule: short rule label
- issue: concise description of what is wrong in this PR
- rationale: why it violates the repo pattern
- evidence: array of { path, line?, quote? } from the diff/context
- suggestion: optional concrete fix

Return { findings: [] } if there are no concrete pattern violations.

Previous review issues to address:
${
	lastReview && !lastReview.approved
		? JSON.stringify(lastReview.issues, null, 2)
		: "none"
}`}
		</Task>
	);
}

function VerifyFindings() {
	const ctx = useCtx();
	const report = ctx.latest(tables.findingsReport, "find-findings");
	if (!report) return null;
	return (
		<Task id="verify-findings" output={outputs.review} agent={reviewer}>
			{`Verify every finding below.

approved=true ONLY if every finding:
- is anchored to a real added line in the diff
- is supported by the diff and provided repo context
- describes a concrete repo-pattern violation rather than a preference
- does not ask for changes outside the touched concern unless the PR clearly
  broke a required companion path

Reject findings that are speculative, style-only, or not grounded in the
existing repo conventions.

Findings:
${JSON.stringify(report, null, 2)}`}
		</Task>
	);
}

function ReviewLoop() {
	const ctx = useCtx();
	const review = ctx.latest(tables.review, "verify-findings");
	return (
		<Loop
			id="pr-pattern-review-loop"
			until={!!review?.approved}
			maxIterations={MAX_REVIEW_ROUNDS}
			onMaxReached="return-last"
		>
			<Sequence>
				<FindFindings />
				<VerifyFindings />
			</Sequence>
		</Loop>
	);
}

export default smithers(() => (
	<Workflow name="redc.pr-pattern-review">
		<Sequence>
			<Analyze />
			<ReviewLoop />
		</Sequence>
	</Workflow>
));
