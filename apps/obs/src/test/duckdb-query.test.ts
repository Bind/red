import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDbRollupQuery } from "../store/duckdb-query";

function sampleRollup(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		request_id: "req-default",
		first_ts: "2026-04-20T10:00:00.000Z",
		last_ts: "2026-04-20T10:00:00.050Z",
		total_duration_ms: 50,
		entry_service: "ctl",
		services: ["ctl"],
		route_names: ["POST /api/foo"],
		has_terminal_event: true,
		request_state: "completed",
		final_outcome: "ok",
		final_status_code: 200,
		event_count: 1,
		error_count: 0,
		primary_error: null,
		request: {},
		service_map: {},
		events: [],
		rollup_reason: "terminal_event",
		rolled_up_at: "2026-04-20T10:00:00.100Z",
		rollup_version: 1,
		...overrides,
	};
}

let rootDir: string;
let query: DuckDbRollupQuery;

beforeAll(() => {
	rootDir = mkdtempSync(join(tmpdir(), "duckdb-rollups-"));
	const hourDir = join(rootDir, "date=2026-04-20", "hour=10");
	mkdirSync(hourDir, { recursive: true });
	const records = [
		sampleRollup({
			request_id: "req-ok-1",
			entry_service: "ctl",
			final_outcome: "ok",
			total_duration_ms: 30,
		}),
		sampleRollup({
			request_id: "req-ok-2",
			entry_service: "bff",
			final_outcome: "ok",
			total_duration_ms: 120,
			route_names: ["GET /rpc/me"],
		}),
		sampleRollup({
			request_id: "req-err-1",
			entry_service: "ctl",
			final_outcome: "error",
			final_status_code: 500,
			total_duration_ms: 900,
			error_count: 1,
			primary_error: { name: "BoomError", message: "kaboom" },
		}),
		sampleRollup({
			request_id: "req-err-2",
			entry_service: "auth",
			final_outcome: "error",
			final_status_code: 503,
			total_duration_ms: 200,
			error_count: 1,
			primary_error: { name: "BoomError", message: "degraded" },
		}),
	];
	writeFileSync(
		join(hourDir, "rollups.ndjson"),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	query = new DuckDbRollupQuery({ source: { kind: "file", rootDir } });
});

afterAll(() => {
	rmSync(rootDir, { recursive: true, force: true });
});

describe("DuckDbRollupQuery", () => {
	test("listRollups returns all rows ordered newest-first", async () => {
		const rows = await query.listRollups({ limit: 10 });
		expect(rows).toHaveLength(4);
		expect(rows.every((r) => typeof r.request_id === "string")).toBe(true);
		expect(typeof rows[0]?.first_ts).toBe("string");
		expect(typeof rows[0]?.last_ts).toBe("string");
		expect(typeof rows[0]?.rolled_up_at).toBe("string");
	});

	test("listRollups filters by entry_service", async () => {
		const rows = await query.listRollups({ service: "ctl", limit: 10 });
		expect(rows.map((r) => r.request_id).sort()).toEqual([
			"req-err-1",
			"req-ok-1",
		]);
	});

	test("listRollups filters by outcome", async () => {
		const rows = await query.listRollups({ outcome: "error", limit: 10 });
		expect(rows.map((r) => r.request_id).sort()).toEqual([
			"req-err-1",
			"req-err-2",
		]);
	});

	test("getRollup returns a single row by request_id", async () => {
		const row = await query.getRollup("req-err-1");
		expect(row?.final_status_code).toBe(500);
	});

	test("getRollup returns null for an unknown request", async () => {
		const row = await query.getRollup("nope");
		expect(row).toBeNull();
	});

	test("aggregateRollups groups by entry_service with counts + p95", async () => {
		const rows = await query.aggregateRollups({ groupBy: "entry_service" });
		const byKey = new Map(rows.map((r) => [r.key, r]));
		expect(byKey.get("ctl")?.count).toBe(2);
		expect(byKey.get("ctl")?.error_count).toBe(1);
		expect(byKey.get("bff")?.error_count).toBe(0);
		expect(byKey.get("auth")?.count).toBe(1);
	});

	test("aggregateRollups groupBy=error_name collapses null primary_error", async () => {
		const rows = await query.aggregateRollups({ groupBy: "error_name" });
		const boom = rows.find((r) => r.key === "BoomError");
		expect(boom?.count).toBe(2);
	});

	test("aggregateRollups groupBy=route uses first route name", async () => {
		const rows = await query.aggregateRollups({ groupBy: "route" });
		const keys = rows.map((r) => r.key).sort();
		expect(keys).toContain("POST /api/foo");
		expect(keys).toContain("GET /rpc/me");
	});
});
