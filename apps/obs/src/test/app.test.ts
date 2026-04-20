import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../service/app";
import { InMemoryActiveRequestAggregator } from "../service/collector-service";
import { FileRawEventStore } from "../store/raw-event-store";
import { FileRollupStore } from "../store/rollup-store";

let tempDir: string | null = null;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

function createFixtureApp() {
	tempDir = mkdtempSync(join(tmpdir(), "wide-events-collector-"));
	const rawEventsDir = join(tempDir, "raw");
	const rollupDir = join(tempDir, "rollup");
	return {
		app: createApp({
			rawEventStore: new FileRawEventStore(rawEventsDir),
			rollupStore: new FileRollupStore(rollupDir),
			activeRequests: new InMemoryActiveRequestAggregator({
				incompleteGraceMs: 50,
				now: () => new Date("2026-04-08T14:00:00.000Z"),
			}),
		}),
		rawEventsDir,
		rollupDir,
	};
}

describe("wide-events collector app", () => {
	test("reports health", async () => {
		const { app } = createFixtureApp();
		const response = await app.fetch(
			new Request("http://collector.local/health"),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			service: string;
			status: string;
			commit: string;
		};
		expect(body.service).toBe("obs");
		expect(body.status).toBe("ok");
		expect(typeof body.commit).toBe("string");
	});

	test("accepts valid batches, stores raw events, and rolls up terminal requests", async () => {
		const { app, rawEventsDir, rollupDir } = createFixtureApp();
		const response = await app.fetch(
			new Request("http://collector.local/v1/events", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sent_at: "2026-04-08T14:00:00.000Z",
					source: {
						service: "bff",
						instance_id: "bff-1",
					},
					events: [
						{
							event_id: "evt-1",
							request_id: "req-123",
							is_request_root: true,
							service: "bff",
							kind: "request.received",
							ts: "2026-04-08T14:00:00.100Z",
							data: {
								request: {
									method: "POST",
									path: "/session/exchange",
								},
							},
						},
						{
							event_id: "evt-2",
							request_id: "req-123",
							is_request_root: false,
							service: "auth",
							kind: "request.completed",
							ts: "2026-04-08T14:00:00.180Z",
							outcome: "error",
							status_code: 500,
							data: {
								error: {
									name: "AuthError",
									message: "boom",
								},
							},
						},
						{
							event_id: "evt-3",
							request_id: "req-123",
							is_request_root: true,
							service: "bff",
							kind: "request.completed",
							ts: "2026-04-08T14:00:00.200Z",
							ended_at: "2026-04-08T14:00:00.220Z",
							duration_ms: 120,
							outcome: "error",
							status_code: 500,
							data: {
								response: {
									content_type: "application/json",
								},
							},
						},
					],
				}),
			}),
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			accepted: 3,
			rejected: 0,
			request_ids: ["req-123"],
		});

		const bffPath = join(
			rawEventsDir,
			"date=2026-04-08",
			"service=bff",
			"events.ndjson",
		);
		const authPath = join(
			rawEventsDir,
			"date=2026-04-08",
			"service=auth",
			"events.ndjson",
		);
		const rollupPath = join(
			rollupDir,
			"date=2026-04-08",
			"hour=14",
			"rollups.ndjson",
		);
		expect(existsSync(bffPath)).toBe(true);
		expect(existsSync(authPath)).toBe(true);
		expect(readFileSync(bffPath, "utf8")).toContain('"event_id":"evt-1"');
		expect(readFileSync(authPath, "utf8")).toContain('"event_id":"evt-2"');
		expect(readFileSync(rollupPath, "utf8")).toContain(
			'"request_id":"req-123"',
		);
		expect(readFileSync(rollupPath, "utf8")).toContain(
			'"rollup_reason":"terminal_event"',
		);
	});

	test("returns partial acceptance for invalid events", async () => {
		const { app, rawEventsDir } = createFixtureApp();
		const response = await app.fetch(
			new Request("http://collector.local/v1/events", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sent_at: "2026-04-08T14:00:00.000Z",
					source: {
						service: "api",
					},
					events: [
						{
							event_id: "evt-ok",
							request_id: "req-ok",
							is_request_root: true,
							service: "api",
							kind: "request.completed",
							ts: "2026-04-08T14:00:00.100Z",
							data: {},
						},
						{
							event_id: "evt-bad",
							service: "api",
							kind: "request.completed",
							ts: "2026-04-08T14:00:00.100Z",
							data: {},
						},
					],
				}),
			}),
		);

		expect(response.status).toBe(207);
		expect(await response.json()).toEqual({
			accepted: 1,
			rejected: 1,
			request_ids: ["req-ok"],
			errors: [
				{
					event_id: "evt-bad",
					reason: "request_id is required",
				},
			],
		});

		const storedPath = join(
			rawEventsDir,
			"date=2026-04-08",
			"service=api",
			"events.ndjson",
		);
		expect(readFileSync(storedPath, "utf8")).toContain('"event_id":"evt-ok"');
		expect(readFileSync(storedPath, "utf8")).not.toContain(
			'"event_id":"evt-bad"',
		);
	});

	test("flushes stale requests as incomplete rollups", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "wide-events-collector-timeout-"));
		const rawEventsDir = join(tempDir, "raw");
		const rollupDir = join(tempDir, "rollup");
		let now = new Date("2026-04-08T14:00:00.000Z");
		const app = createApp({
			rawEventStore: new FileRawEventStore(rawEventsDir),
			rollupStore: new FileRollupStore(rollupDir),
			activeRequests: new InMemoryActiveRequestAggregator({
				incompleteGraceMs: 50,
				now: () => now,
			}),
		});

		const response = await app.fetch(
			new Request("http://collector.local/v1/events", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sent_at: "2026-04-08T14:00:00.000Z",
					source: { service: "api" },
					events: [
						{
							event_id: "evt-open",
							request_id: "req-open",
							is_request_root: true,
							service: "api",
							kind: "request.received",
							ts: "2026-04-08T14:00:00.000Z",
							data: {
								request: { method: "GET", path: "/changes" },
							},
						},
					],
				}),
			}),
		);
		expect(response.status).toBe(202);

		now = new Date("2026-04-08T14:00:00.200Z");
		const flushed = await app.flushExpired(now);
		expect(flushed).toBe(1);

		const rollupPath = join(
			rollupDir,
			"date=2026-04-08",
			"hour=14",
			"rollups.ndjson",
		);
		expect(readFileSync(rollupPath, "utf8")).toContain(
			'"request_state":"incomplete"',
		);
		expect(readFileSync(rollupPath, "utf8")).toContain(
			'"rollup_reason":"timeout"',
		);
	});
});
