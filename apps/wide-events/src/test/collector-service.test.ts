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
						is_request_root: true,
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
						is_request_root: true,
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
						is_request_root: true,
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

	test("waits for the root terminal event before rolling up a fanout request", async () => {
		const fixture = createDeps();
		await acceptCollectorBatch(
			{
				sent_at: "2026-04-08T14:00:00.000Z",
				source: { service: "bff" },
				events: [
					{
						event_id: "evt-bff",
						request_id: "req-fanout",
						is_request_root: true,
						service: "bff",
						kind: "request",
						ts: "2026-04-08T14:00:00.000Z",
						data: {
							request: { method: "GET", path: "/health" },
						},
					},
					{
						event_id: "evt-auth",
						request_id: "req-fanout",
						is_request_root: false,
						service: "auth",
						kind: "request",
						ts: "2026-04-08T14:00:00.005Z",
						status_code: 200,
						outcome: "ok",
						data: {},
					},
				],
			},
			fixture.deps,
		);

		expect(fixture.rollup.calls).toHaveLength(0);

		await acceptCollectorBatch(
			{
				sent_at: "2026-04-08T14:00:00.020Z",
				source: { service: "bff" },
				events: [
					{
						event_id: "evt-api",
						request_id: "req-fanout",
						is_request_root: false,
						service: "api",
						kind: "request",
						ts: "2026-04-08T14:00:00.010Z",
						status_code: 200,
						outcome: "ok",
						data: {},
					},
					{
						event_id: "evt-bff-complete",
						request_id: "req-fanout",
						is_request_root: true,
						service: "bff",
						kind: "request",
						ts: "2026-04-08T14:00:00.015Z",
						ended_at: "2026-04-08T14:00:00.020Z",
						duration_ms: 20,
						status_code: 200,
						outcome: "ok",
						data: {},
					},
				],
			},
			fixture.deps,
		);

		expect(fixture.rollup.calls).toHaveLength(1);
		expect(fixture.rollup.calls[0]?.[0]).toMatchObject({
			request_id: "req-fanout",
			services: ["bff", "auth", "api"],
			event_count: 4,
			entry_service: "bff",
		});
	});
});
