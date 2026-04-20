import { buildHealth, statusHttpCode } from "@redc/health";
import { Hono } from "hono";
import type { WideCollectorBatchResponse } from "./collector-contract";
import {
	acceptCollectorBatch,
	type CollectorDependencies,
	flushExpiredCollectorRequests,
} from "./collector-service";

export interface CollectorApp extends Hono {
	flushExpired(now?: Date): Promise<number>;
}

export function createApp(deps: CollectorDependencies): CollectorApp {
	const app = new Hono();

	app.get("/health", (c) => {
		const health = buildHealth({ service: "obs" });
		return c.json(health, statusHttpCode(health.status));
	});

	// Prefer deps.rollupQuery (duckdb) when present; fall back to the writer
	// store's optional read methods (native FileRollupStore / MinioRollupStore).
	const listRollups = deps.rollupQuery
		? deps.rollupQuery.listRollups.bind(deps.rollupQuery)
		: deps.rollupStore.listRollups?.bind(deps.rollupStore);
	const getRollup = deps.rollupQuery
		? deps.rollupQuery.getRollup.bind(deps.rollupQuery)
		: deps.rollupStore.getRollup?.bind(deps.rollupStore);
	const aggregateRollups = deps.rollupQuery?.aggregateRollups?.bind(
		deps.rollupQuery,
	);

	app.get("/v1/rollups", async (c) => {
		if (!listRollups) {
			return c.json({ error: "listRollups not supported by this store" }, 501);
		}
		const service = c.req.query("service") ?? undefined;
		const outcomeRaw = c.req.query("outcome");
		const outcome =
			outcomeRaw === "ok" || outcomeRaw === "error" || outcomeRaw === "unknown"
				? outcomeRaw
				: undefined;
		const sinceRaw = c.req.query("since");
		const since =
			sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
				? new Date(sinceRaw)
				: undefined;
		const limitRaw = c.req.query("limit");
		const limit = limitRaw
			? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 500)
			: 100;
		const records = await listRollups({ service, outcome, since, limit });
		return c.json({ rollups: records, count: records.length });
	});

	app.get("/v1/rollups/stats", async (c) => {
		if (!aggregateRollups) {
			return c.json(
				{ error: "aggregate queries require OBS_QUERY_BACKEND=duckdb" },
				501,
			);
		}
		const groupByRaw = c.req.query("groupBy") ?? "entry_service";
		const allowed = [
			"entry_service",
			"route",
			"final_outcome",
			"error_name",
		] as const;
		if (!(allowed as readonly string[]).includes(groupByRaw)) {
			return c.json(
				{ error: `groupBy must be one of ${allowed.join(", ")}` },
				400,
			);
		}
		const sinceRaw = c.req.query("since");
		const since =
			sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
				? new Date(sinceRaw)
				: undefined;
		const limitRaw = c.req.query("limit");
		const limit = limitRaw
			? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 500)
			: 50;
		const rows = await aggregateRollups({
			groupBy: groupByRaw as (typeof allowed)[number],
			since,
			limit,
		});
		return c.json({ rows });
	});

	app.get("/v1/rollups/:request_id", async (c) => {
		if (!getRollup) {
			return c.json({ error: "getRollup not supported by this store" }, 501);
		}
		const record = await getRollup(c.req.param("request_id"));
		if (!record) return c.json({ error: "not found" }, 404);
		return c.json(record);
	});

	app.post("/v1/events", async (c) => {
		const payload = await c.req.json().catch(() => null);
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return c.json(
				{
					accepted: 0,
					rejected: 0,
					request_ids: [],
					errors: [
						{
							event_id: "batch",
							reason: "request body must be a JSON object",
						},
					],
				} satisfies WideCollectorBatchResponse,
				400,
			);
		}

		const result = await acceptCollectorBatch(payload, deps);
		return c.json(result.body, result.status as 202 | 207 | 400);
	});

	return Object.assign(app, {
		flushExpired(now?: Date) {
			return flushExpiredCollectorRequests(deps, now);
		},
	});
}
