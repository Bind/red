import { SmithersHttpClient } from "./smithers-client";
import type {
	TriageWorkflowEvent,
	TriageWorkflowHandle,
	TriageWorkflowRunner,
} from "./runner";
import type { WideRollupRecord } from "../types";

export interface SmithersRunnerOptions {
	client: SmithersHttpClient;
	workflowPath: string;
	approvalNodeId?: string;
}

export class SmithersTriageRunner implements TriageWorkflowRunner {
	private readonly client: SmithersHttpClient;
	private readonly workflowPath: string;
	private readonly approvalNodeId: string;

	constructor(options: SmithersRunnerOptions) {
		this.client = options.client;
		this.workflowPath = options.workflowPath;
		this.approvalNodeId = options.approvalNodeId ?? "human-gate";
	}

	async start(
		rollup: WideRollupRecord,
		onEvent: (event: TriageWorkflowEvent) => void,
	): Promise<TriageWorkflowHandle> {
		const { runId } = await this.client.startRun({
			workflowPath: this.workflowPath,
			input: { rollup },
		});

		const abort = new AbortController();
		const planNodeId = "draft";
		const proposalNodeId = "implement";
		let planEmitted = false;
		let proposalEmitted = false;

		void (async () => {
			try {
				for await (const event of this.client.events(runId, {
					signal: abort.signal,
				})) {
					if (
						!planEmitted &&
						event.type === "WaitingForApproval" &&
						event.nodeId === this.approvalNodeId
					) {
						planEmitted = true;
						onEvent({
							kind: "plan_ready",
							plan: this.client.readTriagePlan(runId),
						});
						continue;
					}

					if (
						!proposalEmitted &&
						event.type === "NodeFinished" &&
						event.nodeId === proposalNodeId
					) {
						proposalEmitted = true;
						onEvent({
							kind: "proposal_ready",
							proposal: this.client.readTriageProposal(runId),
						});
						continue;
					}

					if (event.type === "RunFailed" || event.type === "RunCancelled") {
						const message =
							typeof event.error === "string"
								? event.error
								: `run ${event.type}`;
						onEvent({ kind: "failed", error: message });
						return;
					}

					if (event.type === "RunFinished") return;
				}
			} catch (error) {
				if (abort.signal.aborted) return;
				const message = error instanceof Error ? error.message : String(error);
				onEvent({ kind: "failed", error: message });
			}
		})();

		return {
			runId,
			approve: async () => {
				await this.client.approve(runId, this.approvalNodeId);
			},
			reject: async () => {
				abort.abort();
				await this.client.deny(runId, this.approvalNodeId);
				await this.client.cancel(runId).catch(() => {});
			},
		};
	}
}
