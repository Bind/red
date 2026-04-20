/**
 * Docs-review Smithers workflow.
 *
 * Input JSON (via `smithers up workflow.tsx -i @in.json`):
 *   DocsReviewInput { pr, diff, markdown_files }
 *
 * Shape: analyze-diff → Loop( find-findings → verify-findings ) until reviewer
 * approves or maxIterations. Final output row is `findings_report` for node
 * "find-findings" on the last iteration.
 */

import {
	CodexAgent,
	createSmithers,
	Loop,
	Sequence,
} from "smithers-orchestrator";
import {
	DiffAnalysisSchema,
	DocsReviewInputSchema,
	FindingsReportSchema,
	ReviewSchema,
} from "./types";

const MAX_REVIEW_ROUNDS = 2;

const { Workflow, Task, smithers, tables, outputs, useCtx } = createSmithers(
	{
		input: DocsReviewInputSchema,
		diffAnalysis: DiffAnalysisSchema,
		findingsReport: FindingsReportSchema,
		review: ReviewSchema,
	},
	{
		dbPath: process.env.DOCS_REVIEW_DB_PATH ?? "./smithers.db",
	},
);

const reviewer = new CodexAgent({
	model: process.env.DOCS_REVIEW_SUBSCRIPTION_MODEL ?? "gpt-5.3-codex",
	sandbox: "danger-full-access",
	fullAuto: true,
	config: {
		model_reasoning_effort:
			process.env.DOCS_REVIEW_SUBSCRIPTION_REASONING_EFFORT ?? "high",
	},
	timeoutMs: 30 * 60 * 1000,
});

function Analyze() {
	const ctx = useCtx();
	const input = ctx.latest(tables.input, "input");
	const filesList = input?.diff.files.map((f) => f.path).join(", ") ?? "";
	return (
		<Task id="analyze-diff" output={outputs.diffAnalysis} agent={reviewer}>
			{`Summarize this PR for a docs-staleness reviewer. Identify the affected
areas of the codebase and the symbols whose behaviour or signature changed.

PR #${input?.pr.number}: ${input?.pr.title}
Files changed: ${filesList}

Return concise fields — downstream tasks will read the same input JSON.`}
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
			{`Identify every markdown claim that the PR diff contradicts.

PR diff (patches):
${JSON.stringify(input?.diff.files ?? [], null, 2)}

Markdown files in the repo (path → content):
${JSON.stringify(input?.markdown_files ?? {}, null, 2)}

For each stale claim produce a Finding:
  - doc_path, doc_line (1-indexed line in the markdown file carrying the claim)
  - claim: the exact phrase that is wrong
  - evidence: array of {path, line?, quote?} references in the PR diff that
    prove staleness. line must refer to a line present in the diff.
  - severity: critical | major | minor | nit
  - suggestion: optional concrete rewrite

Return { findings: [] } if no staleness found. Do NOT invent claims or lines.

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

approved=true ONLY if, for every finding:
  - doc_line is a real line in the referenced markdown file that carries the
    claim verbatim
  - every evidence[].path appears in the PR diff
  - every evidence[].line (when set) appears in the hunks for that path
  - the diff genuinely contradicts the claim

Otherwise return structured issues describing which finding is wrong and why.
A finding that is merely low-priority is NOT a reason to reject — we care only
about correctness.

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
			id="docs-review-loop"
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
	<Workflow name="redc.docs-review">
		<Sequence>
			<Analyze />
			<ReviewLoop />
		</Sequence>
	</Workflow>
));
