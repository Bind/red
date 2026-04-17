/**
 * Smithers workflow: generate a code proposal from an approved plan.
 * Input: { rollup, plan } — an approved TriagePlan.
 * Output: TriageProposal (repo_id, branch, optional pr_url, summary).
 *
 * Runs only after a human approves the plan from investigate.tsx.
 * Produces a branch pushed through grs and opens a PR.
 */

import { Workflow, Node, Prompt, Output } from "smithers";
import { TriagePlanSchema, TriageProposalSchema, WideRollupRecordSchema } from "../types";
import { z } from "zod";

const InputSchema = z.object({
	rollup: WideRollupRecordSchema,
	plan: TriagePlanSchema,
});

export default (
	<Workflow name="redc.triage.propose" inputSchema={InputSchema}>
		<Node id="implement">
			<Prompt model="claude-code">
				You are implementing the fix described in the approved plan.
				Create a branch in the affected repo via the grs Git SDK, commit
				the minimal change that addresses the hypothesis, and open a
				pull request. Do not touch unrelated files.
			</Prompt>
			<Output schema={TriageProposalSchema} />
		</Node>
	</Workflow>
);
