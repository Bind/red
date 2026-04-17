import type { TriagePlan, TriageProposal, WideRollupRecord } from "../types";

export interface TriageWorkflowRunner {
	investigate(rollup: WideRollupRecord): Promise<TriagePlan>;
	propose(input: {
		rollup: WideRollupRecord;
		plan: TriagePlan;
	}): Promise<TriageProposal>;
}

export class StubTriageWorkflowRunner implements TriageWorkflowRunner {
	async investigate(rollup: WideRollupRecord): Promise<TriagePlan> {
		const primary = (rollup.primary_error ?? {}) as Record<string, unknown>;
		const errorName =
			typeof primary.name === "string" ? primary.name : "UnknownError";
		const errorMessage =
			typeof primary.message === "string" ? primary.message : "";
		return {
			hypothesis: `${errorName} originating in ${rollup.entry_service}: ${errorMessage}`,
			suspected_files: [],
			reproduction_steps: [
				`Replay request ${rollup.request_id} against ${rollup.entry_service}`,
			],
			proposed_change_summary:
				"Placeholder plan — real investigation runs once the Smithers workflow is wired in.",
			confidence: "low",
		};
	}

	async propose(input: {
		rollup: WideRollupRecord;
		plan: TriagePlan;
	}): Promise<TriageProposal> {
		return {
			repo_id: input.rollup.entry_service,
			branch: `triage/${input.rollup.request_id}`,
			summary: `Stub proposal for ${input.plan.hypothesis}`,
		};
	}
}
