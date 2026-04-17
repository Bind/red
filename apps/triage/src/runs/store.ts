import type { TriageRun, TriageRunStatus } from "../types";

export interface RunStore {
	create(run: TriageRun): TriageRun;
	get(id: string): TriageRun | undefined;
	list(): TriageRun[];
	update(id: string, patch: Partial<TriageRun>): TriageRun;
}

export class InMemoryRunStore implements RunStore {
	private readonly runs = new Map<string, TriageRun>();
	private readonly now: () => Date;

	constructor(options: { now?: () => Date } = {}) {
		this.now = options.now ?? (() => new Date());
	}

	create(run: TriageRun): TriageRun {
		this.runs.set(run.id, run);
		return run;
	}

	get(id: string): TriageRun | undefined {
		return this.runs.get(id);
	}

	list(): TriageRun[] {
		return [...this.runs.values()].sort((left, right) =>
			right.created_at.localeCompare(left.created_at),
		);
	}

	update(id: string, patch: Partial<TriageRun>): TriageRun {
		const existing = this.runs.get(id);
		if (!existing) {
			throw new Error(`run ${id} not found`);
		}
		const next: TriageRun = {
			...existing,
			...patch,
			updated_at: this.now().toISOString(),
		};
		this.runs.set(id, next);
		return next;
	}
}

export function isTerminalStatus(status: TriageRunStatus): boolean {
	return (
		status === "proposal_ready" ||
		status === "rejected" ||
		status === "failed"
	);
}
