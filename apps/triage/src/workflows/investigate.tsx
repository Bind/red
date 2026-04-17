/**
 * Smithers workflow: investigate a 5xx error rollup.
 * Input: { rollup: WideRollupRecord }
 * Output: TriagePlan (validated by TriagePlanSchema in ../types.ts)
 *
 * The investigation node reads the rollup, identifies suspected files by
 * grepping the entry service for symbols named in the error, and drafts a
 * human-readable plan. It MUST NOT write any code — that happens in
 * propose.tsx after human approval.
 */

import { Workflow, Node, Prompt, Output } from "smithers";
import { TriagePlanSchema, WideRollupRecordSchema } from "../types";

export default (
	<Workflow name="redc.triage.investigate" inputSchema={WideRollupRecordSchema.pick({})} >
		<Node id="summarize">
			<Prompt model="claude-code">
				You are triaging a 5xx error in the redc codebase.
				Read the attached wide-event rollup. Identify:
				(1) the most likely root cause,
				(2) the service and files most likely involved,
				(3) steps to reproduce,
				(4) a one-paragraph summary of the smallest fix.
				Do NOT propose code yet — a human will approve the plan first.
			</Prompt>
			<Output schema={TriagePlanSchema} />
		</Node>
	</Workflow>
);
