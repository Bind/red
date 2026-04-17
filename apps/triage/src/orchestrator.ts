import { randomUUID } from "node:crypto";
import type { RunStore } from "./runs/store";
import type { TriageRun, WideRollupRecord } from "./types";
import type {
	TriageWorkflowHandle,
	TriageWorkflowRunner,
} from "./workflows/runner";

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
	private readonly handles = new Map<string, TriageWorkflowHandle>();

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

		const handle = await this.runner.start(rollup, (event) => {
			try {
				if (event.kind === "plan_ready") {
					this.publish(id, {
						status: "plan_ready",
						plan: event.plan,
					});
				} else if (event.kind === "proposal_ready") {
					this.publish(id, {
						status: "proposal_ready",
						proposal: event.proposal,
					});
				} else if (event.kind === "failed") {
					this.publish(id, {
						status: "failed",
						error: event.error,
					});
				}
			} catch (error) {
				console.error(`orchestrator event handler failed for ${id}:`, error);
			}
		});

		this.handles.set(id, handle);
		this.publish(id, { status: "investigating" });
		return this.store.get(id) ?? run;
	}

	async approve(id: string): Promise<TriageRun> {
		const run = this.requireRun(id);
		if (run.status !== "plan_ready") {
			throw new Error(
				`run ${id} is not ready for approval (status=${run.status})`,
			);
		}
		const handle = this.handles.get(id);
		if (!handle) throw new Error(`run ${id} has no active handle`);
		this.publish(id, { status: "approved" });
		await handle.approve();
		this.publish(id, { status: "proposing" });
		return this.requireRun(id);
	}

	async reject(id: string): Promise<TriageRun> {
		const run = this.requireRun(id);
		const handle = this.handles.get(id);
		if (handle) await handle.reject().catch(() => {});
		this.handles.delete(id);
		this.publish(id, { status: "rejected" });
		return this.requireRun(id);
	}

	private publish(id: string, patch: Partial<TriageRun>): TriageRun {
		const updated = this.store.update(id, patch);
		this.onRunUpdate(updated);
		return updated;
	}

	private requireRun(id: string): TriageRun {
		const run = this.store.get(id);
		if (!run) throw new Error(`run ${id} not found`);
		return run;
	}
}
