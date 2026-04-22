import { describe, expect, test } from "bun:test";
import type { WideRollupRecord } from "../service/collector-contract";
import {
	DedupingTriageDispatcher,
	HttpTriageDispatcher,
	type TriageDispatcher,
	shouldTriage,
	triageFingerprint,
} from "../service/triage-dispatcher";

function createRollup(overrides: Partial<WideRollupRecord> = {}): WideRollupRecord {
	return {
		request_id: "req-1",
		first_ts: "2026-04-17T10:00:00.000Z",
		last_ts: "2026-04-17T10:00:00.050Z",
		total_duration_ms: 50,
		entry_service: "ctl",
		services: ["ctl"],
		route_names: ["POST /v1/jobs"],
		has_terminal_event: true,
		request_state: "completed",
		final_outcome: "error",
		final_status_code: 500,
		event_count: 1,
		error_count: 1,
		primary_error: { name: "BoomError", message: "connection refused on port 5432" },
		request: {},
		service_map: {},
		events: [],
		rollup_reason: "terminal_event",
		rolled_up_at: "2026-04-17T10:00:00.100Z",
		rollup_version: 1,
		...overrides,
	};
}

class RecordingDispatcher implements TriageDispatcher {
	readonly calls: WideRollupRecord[] = [];

	async dispatch(rollup: WideRollupRecord): Promise<void> {
		this.calls.push(rollup);
	}
}

describe("shouldTriage", () => {
	test("accepts 5xx error rollups", () => {
		expect(shouldTriage(createRollup(), { minStatusCode: 500 })).toBe(true);
	});

	test("rejects ok outcomes", () => {
		expect(
			shouldTriage(
				createRollup({ final_outcome: "ok", final_status_code: 200 }),
				{ minStatusCode: 500 },
			),
		).toBe(false);
	});

	test("rejects 4xx errors when threshold is 500", () => {
		expect(
			shouldTriage(
				createRollup({ final_status_code: 404 }),
				{ minStatusCode: 500 },
			),
		).toBe(false);
	});

	test("rejects rollups with no status code", () => {
		expect(
			shouldTriage(
				createRollup({ final_status_code: null }),
				{ minStatusCode: 500 },
			),
		).toBe(false);
	});
});

describe("triageFingerprint", () => {
	test("groups semantically identical errors with varying numeric payloads", () => {
		const a = triageFingerprint(
			createRollup({
				primary_error: {
					name: "DbError",
					message: "timeout after 1234ms connecting to 10.0.0.5:5432",
				},
			}),
		);
		const b = triageFingerprint(
			createRollup({
				primary_error: {
					name: "DbError",
					message: "timeout after 9999ms connecting to 10.0.0.7:5432",
				},
			}),
		);
		expect(a).toBe(b);
	});

	test("distinguishes different error names", () => {
		const a = triageFingerprint(createRollup());
		const b = triageFingerprint(
			createRollup({ primary_error: { name: "OtherError", message: "x" } }),
		);
		expect(a).not.toBe(b);
	});

	test("distinguishes different entry services", () => {
		const a = triageFingerprint(createRollup());
		const b = triageFingerprint(createRollup({ entry_service: "auth" }));
		expect(a).not.toBe(b);
	});
});

describe("DedupingTriageDispatcher", () => {
	test("dispatches once per fingerprint within TTL", async () => {
		const recording = new RecordingDispatcher();
		let now = 1_000_000;
		const dispatcher = new DedupingTriageDispatcher({
			inner: recording,
			filter: { minStatusCode: 500 },
			dedupTtlMs: 15 * 60_000,
			now: () => now,
		});

		await dispatcher.dispatch(createRollup());
		await dispatcher.dispatch(createRollup({ request_id: "req-2" }));
		expect(recording.calls).toHaveLength(1);

		now += 16 * 60_000;
		await dispatcher.dispatch(createRollup({ request_id: "req-3" }));
		expect(recording.calls).toHaveLength(2);
	});

	test("filters out 2xx rollups", async () => {
		const recording = new RecordingDispatcher();
		const dispatcher = new DedupingTriageDispatcher({
			inner: recording,
			filter: { minStatusCode: 500 },
			dedupTtlMs: 1000,
		});
		await dispatcher.dispatch(
			createRollup({ final_outcome: "ok", final_status_code: 200 }),
		);
		expect(recording.calls).toHaveLength(0);
	});

	test("different fingerprints dispatch independently", async () => {
		const recording = new RecordingDispatcher();
		const dispatcher = new DedupingTriageDispatcher({
			inner: recording,
			filter: { minStatusCode: 500 },
			dedupTtlMs: 1000,
		});
		await dispatcher.dispatch(createRollup());
		await dispatcher.dispatch(createRollup({ entry_service: "auth" }));
		expect(recording.calls).toHaveLength(2);
	});
});

describe("HttpTriageDispatcher", () => {
	test("POSTs the rollup envelope to the configured endpoint", async () => {
		const captured: { url: string; body: unknown }[] = [];
		const fakeFetch = async (url: RequestInfo | URL | Request, init?: RequestInit) => {
			captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response(null, { status: 202 });
		};
		const dispatcher = new HttpTriageDispatcher({
			endpointUrl: "http://triage:7000/v1/runs",
			fetchImpl: fakeFetch,
		});
		await dispatcher.dispatch(createRollup());
		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe("http://triage:7000/v1/runs");
		expect(captured[0].body).toMatchObject({
			rollup: { request_id: "req-1", final_status_code: 500 },
		});
	});

	test("swallows errors via onError callback", async () => {
		const errors: unknown[] = [];
		const fakeFetch = async () => {
			throw new Error("network");
		};
		const dispatcher = new HttpTriageDispatcher({
			endpointUrl: "http://triage:7000/v1/runs",
			fetchImpl: fakeFetch,
			onError: (error) => errors.push(error),
		});
		await expect(dispatcher.dispatch(createRollup())).resolves.toBeUndefined();
		expect(errors).toHaveLength(1);
	});
});
