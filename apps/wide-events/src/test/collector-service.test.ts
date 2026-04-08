import { describe, expect, test } from "bun:test";
import type { WideRollupRecord } from "../service/collector-contract";
import {
	type AcceptedCollectorBatch,
	acceptCollectorBatch,
	type CollectorDependencies,
	InMemoryActiveRequestAggregator,
	type RawEventStore,
	type RollupStore,
} from "../service/collector-service";

class RecordingRawEventStore implements RawEventStore {
	readonly calls: AcceptedCollectorBatch[] = [];

	constructor(private readonly log: string[]) {}

	appendBatch(batch: AcceptedCollectorBatch): void {
		this.log.push("raw");
		this.calls.push(batch);
	}

	async listEventsSince(): Promise<never[]> {
		return [];
	}
}

class RecordingRollupStore implements RollupStore {
	readonly calls: WideRollupRecord[][] = [];

	constructor(private readonly log: string[]) {}

	appendRollups(records: WideRollupRecord[]): void {
		this.log.push("rollup");
		this.calls.push(records);
	}
}

function createDeps(now = new Date("2026-04-08T14:00:00.000Z")): {
	deps: CollectorDependencies;
	log: string[];
	rollup: RecordingRollupStore;
} {
	const log: string[] = [];
	const raw = new RecordingRawEventStore(log);
	const rollup = new RecordingRollupStore(log);
	return {
		deps: {
			rawEventStore: raw,
			rollupStore: rollup,
			activeRequests: new InMemoryActiveRequestAggregator({
				incompleteGraceMs: 1000,
				now: () => now,
			}),
		},
		log,
		rollup,
	};
}

describe("collector service", () => {
	test("writes raw before rollup emission", async () => {
		const fixture = createDeps();
		await acceptCollectorBatch(
			{
				sent_at: "2026-04-08T14:00:00.000Z",
				source: { service: "api" },
				events: [
					{
						event_id: "evt-1",
						request_id: "req-1",
						service: "api",
						kind: "request.completed",
						ts: "2026-04-08T14:00:00.000Z",
						status_code: 200,
						outcome: "ok",
						data: {},
					},
				],
			},
			fixture.deps,
		);

		expect(fixture.log).toEqual(["raw", "rollup"]);
	});

	test("suppresses duplicate rollups for a recently settled request", async () => {
		const fixture = createDeps();
		await acceptCollectorBatch(
			{
				sent_at: "2026-04-08T14:00:00.000Z",
				source: { service: "api" },
				events: [
					{
						event_id: "evt-1",
						request_id: "req-1",
						service: "api",
						kind: "request.completed",
						ts: "2026-04-08T14:00:00.000Z",
						status_code: 200,
						outcome: "ok",
						data: {},
					},
				],
			},
			fixture.deps,
		);
		await acceptCollectorBatch(
			{
				sent_at: "2026-04-08T14:00:01.000Z",
				source: { service: "api" },
				events: [
					{
						event_id: "evt-2",
						request_id: "req-1",
						service: "api",
						kind: "request.completed",
						ts: "2026-04-08T14:00:01.000Z",
						status_code: 200,
						outcome: "ok",
						data: {},
					},
				],
			},
			fixture.deps,
		);

		expect(fixture.rollup.calls).toHaveLength(1);
	});
});
