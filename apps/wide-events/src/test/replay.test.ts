import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemoryActiveRequestAggregator,
	replayCollectorFromRaw,
} from "../service/collector-service";
import { FileRawEventStore } from "../store/raw-event-store";
import { FileRollupStore } from "../store/rollup-store";

let tempDir: string | null = null;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

describe("replayCollectorFromRaw", () => {
	test("rebuilds rollups from raw events after a restart", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "wide-events-replay-"));
		const rawEventStore = new FileRawEventStore(join(tempDir, "raw"));
		const rollupStore = new FileRollupStore(join(tempDir, "rollup"));

		await rawEventStore.appendBatch({
			sent_at: "2026-04-08T14:00:00.000Z",
			source: { service: "api" },
			events: [
				{
					event_id: "evt-1",
					request_id: "req-1",
					service: "api",
					kind: "request.received",
					ts: "2026-04-08T14:00:00.000Z",
					data: {
						request: { method: "GET", path: "/changes" },
					},
				},
				{
					event_id: "evt-2",
					request_id: "req-1",
					service: "api",
					kind: "request.completed",
					ts: "2026-04-08T14:00:00.010Z",
					status_code: 200,
					outcome: "ok",
					data: {},
				},
			],
		});

		const result = await replayCollectorFromRaw(
			{
				rawEventStore,
				rollupStore,
				activeRequests: new InMemoryActiveRequestAggregator({
					incompleteGraceMs: 60_000,
					now: () => new Date("2026-04-08T14:00:01.000Z"),
				}),
			},
			new Date("2026-04-08T13:59:00.000Z"),
			new Date("2026-04-08T14:00:01.000Z"),
		);

		expect(result).toEqual({
			replayedEvents: 2,
			emittedRollups: 1,
		});

		const rollupPath = join(
			tempDir,
			"rollup",
			"date=2026-04-08",
			"hour=14",
			"rollups.ndjson",
		);
		expect(readFileSync(rollupPath, "utf8")).toContain('"request_id":"req-1"');
	});
});
