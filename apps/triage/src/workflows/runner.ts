import type { TriagePlan, TriageProposal, WideRollupRecord } from "../types";

export type TriageWorkflowEvent =
	| { kind: "plan_ready"; plan: TriagePlan }
	| { kind: "proposal_ready"; proposal: TriageProposal }
	| { kind: "failed"; error: string };

export interface TriageWorkflowHandle {
	runId: string;
	approve(): Promise<void>;
	reject(): Promise<void>;
}

export interface TriageWorkflowRunner {
	start(
		rollup: WideRollupRecord,
		onEvent: (event: TriageWorkflowEvent) => void,
	): Promise<TriageWorkflowHandle>;
}

export class StubTriageWorkflowRunner implements TriageWorkflowRunner {
	private counter = 0;

	async start(
		rollup: WideRollupRecord,
		onEvent: (event: TriageWorkflowEvent) => void,
	): Promise<TriageWorkflowHandle> {
		const runId = `stub-run-${++this.counter}`;
		const primary = (rollup.primary_error ?? {}) as Record<string, unknown>;
		const errorName =
			typeof primary.name === "string" ? primary.name : "UnknownError";
		const errorMessage =
			typeof primary.message === "string" ? primary.message : "";

		const plan: TriagePlan = {
			hypothesis: `${errorName} in ${rollup.entry_service}: ${errorMessage}`,
			suspected_files: [],
			reproduction_steps: [
				`Replay request ${rollup.request_id} against ${rollup.entry_service}`,
			],
			proposed_change_summary:
				"Placeholder plan — stub runner returns immediately for local dev.",
			confidence: "low",
		};

		queueMicrotask(() => onEvent({ kind: "plan_ready", plan }));

		return {
			runId,
			approve: async () => {
				const proposal: TriageProposal = {
					repo_id: rollup.entry_service,
					branch: `triage/${rollup.request_id}`,
					summary: `Stub proposal for ${plan.hypothesis}`,
				};
				onEvent({ kind: "proposal_ready", proposal });
			},
			reject: async () => {},
		};
	}
}
