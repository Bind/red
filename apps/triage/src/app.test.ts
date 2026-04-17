import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { TriageOrchestrator } from "./orchestrator";
import { InMemoryRunStore } from "./runs/store";
import type { TriagePlan, TriageProposal, WideRollupRecord } from "./types";
import type {
	TriageWorkflowEvent,
	TriageWorkflowHandle,
	TriageWorkflowRunner,
} from "./workflows/runner";

function sampleRollup(): WideRollupRecord {
	return {
		request_id: "req-1",
		first_ts: "2026-04-17T10:00:00.000Z",
		last_ts: "2026-04-17T10:00:00.050Z",
		total_duration_ms: 50,
		entry_service: "ctl",
		services: ["ctl"],
		route_names: ["POST /v1/jobs"],
		final_outcome: "error",
		final_status_code: 500,
		primary_error: { name: "BoomError", message: "kaboom" },
		events: [],
	};
}

class DeferredRunner implements TriageWorkflowRunner {
	onEvent: ((event: TriageWorkflowEvent) => void) | null = null;
	approveCalls = 0;
	rejectCalls = 0;

	async start(
		_rollup: WideRollupRecord,
		onEvent: (event: TriageWorkflowEvent) => void,
	): Promise<TriageWorkflowHandle> {
		this.onEvent = onEvent;
		return {
			runId: "mock-run-1",
			approve: async () => {
				this.approveCalls += 1;
			},
			reject: async () => {
				this.rejectCalls += 1;
			},
		};
	}
}

async function waitFor<T>(
	predicate: () => T | undefined,
	timeoutMs = 1000,
): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const result = predicate();
		if (result !== undefined) return result;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("timed out waiting for condition");
}

describe("triage app lifecycle", () => {
	test("receive → plan_ready → approve → proposing → proposal_ready", async () => {
		const store = new InMemoryRunStore();
		const runner = new DeferredRunner();
		const orchestrator = new TriageOrchestrator({ store, runner });
		const app = createApp({ store, orchestrator });

		const createRes = await app.request("/v1/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rollup: sampleRollup() }),
		});
		expect(createRes.status).toBe(202);
		const { id } = (await createRes.json()) as { id: string };

		await waitFor(() =>
			store.get(id)?.status === "investigating" ? true : undefined,
		);

		const plan: TriagePlan = {
			hypothesis: "bad query",
			suspected_files: ["apps/ctl/index.ts"],
			reproduction_steps: ["POST /v1/jobs"],
			proposed_change_summary: "add null check",
			confidence: "medium",
		};
		runner.onEvent?.({ kind: "plan_ready", plan });

		await waitFor(() =>
			store.get(id)?.status === "plan_ready" ? true : undefined,
		);

		const approveRes = await app.request(`/v1/runs/${id}/approve`, {
			method: "POST",
		});
		expect(approveRes.status).toBe(200);
		expect(runner.approveCalls).toBe(1);

		await waitFor(() =>
			store.get(id)?.status === "proposing" ? true : undefined,
		);

		const proposal: TriageProposal = {
			repo_id: "ctl",
			branch: "triage/req-1",
			summary: "fix null check",
		};
		runner.onEvent?.({ kind: "proposal_ready", proposal });

		const ready = await waitFor(() => {
			const run = store.get(id);
			return run?.status === "proposal_ready" ? run : undefined;
		});
		expect(ready.proposal?.branch).toBe("triage/req-1");
	});

	test("approving before plan_ready returns 409", async () => {
		const store = new InMemoryRunStore();
		const runner = new DeferredRunner();
		const orchestrator = new TriageOrchestrator({ store, runner });
		const app = createApp({ store, orchestrator });

		const createRes = await app.request("/v1/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rollup: sampleRollup() }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const approveRes = await app.request(`/v1/runs/${id}/approve`, {
			method: "POST",
		});
		expect(approveRes.status).toBe(409);
		expect(runner.approveCalls).toBe(0);
	});

	test("reject cancels the run", async () => {
		const store = new InMemoryRunStore();
		const runner = new DeferredRunner();
		const orchestrator = new TriageOrchestrator({ store, runner });
		const app = createApp({ store, orchestrator });

		const createRes = await app.request("/v1/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rollup: sampleRollup() }),
		});
		const { id } = (await createRes.json()) as { id: string };

		const rejectRes = await app.request(`/v1/runs/${id}/reject`, {
			method: "POST",
		});
		expect(rejectRes.status).toBe(200);
		expect(runner.rejectCalls).toBe(1);
		expect(store.get(id)?.status).toBe("rejected");
	});

	test("rejects malformed payloads with 400", async () => {
		const store = new InMemoryRunStore();
		const orchestrator = new TriageOrchestrator({
			store,
			runner: new DeferredRunner(),
		});
		const app = createApp({ store, orchestrator });
		const res = await app.request("/v1/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ nope: true }),
		});
		expect(res.status).toBe(400);
	});
});
