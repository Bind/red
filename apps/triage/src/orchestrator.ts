import { randomUUID } from "node:crypto";
import type { RunStore } from "./runs/store";
import type { TriageRun, WideRollupRecord } from "./types";
import type { TriageWorkflowRunner } from "./workflows/runner";

export interface TriageOrchestratorOptions {
	store: RunStore;
	runner: TriageWorkflowRunner;
	now?: () => Date;
	onRunUpdate?: (run: TriageRun) => void;
}

export class TriageOrchestrator {
	private readonly store: RunStore;
	private readonly runner: TriageWorkflowRunner;
	private readonly now: () => Date;
	private readonly onRunUpdate: (run: TriageRun) => void;

	constructor(options: TriageOrchestratorOptions) {
		this.store = options.store;
		this.runner = options.runner;
		this.now = options.now ?? (() => new Date());
		this.onRunUpdate = options.onRunUpdate ?? (() => {});
	}

	async receive(rollup: WideRollupRecord): Promise<TriageRun> {
		const id = randomUUID();
		const nowIso = this.now().toISOString();
		const run = this.store.create({
			id,
			status: "received",
			created_at: nowIso,
			updated_at: nowIso,
			rollup,
		});
		void this.runInvestigation(run.id);
		return run;
	}

	async approve(id: string): Promise<TriageRun> {
		const run = this.requireRun(id);
		if (run.status !== "plan_ready") {
			throw new Error(`run ${id} is not ready for approval (status=${run.status})`);
		}
		const approved = this.store.update(id, { status: "approved" });
		this.onRunUpdate(approved);
		void this.runProposal(id);
		return approved;
	}

	reject(id: string): TriageRun {
		const run = this.requireRun(id);
		const updated = this.store.update(id, { status: "rejected" });
		this.onRunUpdate(updated);
		return updated;
	}

	private async runInvestigation(id: string): Promise<void> {
		try {
			const inFlight = this.store.update(id, { status: "investigating" });
			this.onRunUpdate(inFlight);
			const plan = await this.runner.investigate(inFlight.rollup);
			const done = this.store.update(id, { status: "plan_ready", plan });
			this.onRunUpdate(done);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failed = this.store.update(id, { status: "failed", error: message });
			this.onRunUpdate(failed);
		}
	}

	private async runProposal(id: string): Promise<void> {
		const run = this.requireRun(id);
		if (!run.plan) {
			throw new Error(`run ${id} has no plan`);
		}
		try {
			const inFlight = this.store.update(id, { status: "proposing" });
			this.onRunUpdate(inFlight);
			const proposal = await this.runner.propose({
				rollup: run.rollup,
				plan: run.plan,
			});
			const done = this.store.update(id, {
				status: "proposal_ready",
				proposal,
			});
			this.onRunUpdate(done);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const failed = this.store.update(id, { status: "failed", error: message });
			this.onRunUpdate(failed);
		}
	}

	private requireRun(id: string): TriageRun {
		const run = this.store.get(id);
		if (!run) {
			throw new Error(`run ${id} not found`);
		}
		return run;
	}
}
