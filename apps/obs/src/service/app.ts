import {
	createRoute,
	createService,
	z,
	type OpenAPIHono,
} from "@redc/server";
import type { WideCollectorBatchResponse } from "./collector-contract";
import {
	acceptCollectorBatch,
	type CollectorDependencies,
	flushExpiredCollectorRequests,
} from "./collector-service";

export interface CollectorApp extends OpenAPIHono {
	flushExpired(now?: Date): Promise<number>;
}

const WideEventSchema = z.object({
	event_id: z.string(),
	request_id: z.string(),
	is_request_root: z.boolean(),
	service: z.string(),
	kind: z.string(),
	ts: z.string(),
	ended_at: z.string().optional(),
	duration_ms: z.number().optional(),
	outcome: z.enum(["ok", "error"]).optional(),
	status_code: z.number().optional(),
	route_name: z.string().optional(),
	error_name: z.string().optional(),
	error_message: z.string().optional(),
	data: z.record(z.string(), z.any()),
});

const WideRollupSchema = z
	.object({
		request_id: z.string(),
		first_ts: z.string(),
		last_ts: z.string(),
		total_duration_ms: z.number(),
		entry_service: z.string(),
		services: z.array(z.string()),
		route_names: z.array(z.string()),
		final_outcome: z.enum(["ok", "error", "unknown"]),
		final_status_code: z.number().nullable(),
		event_count: z.number(),
		error_count: z.number(),
		primary_error: z.record(z.string(), z.any()).nullable(),
		events: z.array(WideEventSchema),
		rolled_up_at: z.string(),
	})
	.openapi("WideRollup");

const RollupListResponseSchema = z.object({
	rollups: z.array(WideRollupSchema),
	count: z.number(),
});

const AggregateRowSchema = z
	.object({
		key: z.string(),
		count: z.number(),
		error_count: z.number(),
		avg_duration_ms: z.number(),
		p95_duration_ms: z.number(),
	})
	.openapi("AggregateRow");

const EventBatchSchema = z
	.object({
		sent_at: z.string(),
		source: z.object({
			service: z.string(),
			instance_id: z.string().optional(),
		}),
		events: z.array(z.record(z.string(), z.any())),
	})
	.openapi("EventBatch");

const BatchResponseSchema = z.object({
	accepted: z.number(),
	rejected: z.number(),
	request_ids: z.array(z.string()),
	errors: z
		.array(z.object({ event_id: z.string(), reason: z.string() }))
		.optional(),
});

export function createApp(deps: CollectorDependencies): CollectorApp {
	const app = createService({
		name: "obs",
		version: "0.1.0",
		description: "Wide-events collector + rollup query engine.",
	});

	const query = deps.rollupQuery;

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/rollups",
			tags: ["rollups"],
			summary: "List request-scoped rollups",
			request: {
				query: z.object({
					service: z.string().optional(),
					outcome: z.enum(["ok", "error", "unknown"]).optional(),
					since: z.string().datetime().optional(),
					limit: z.string().optional(),
				}),
			},
			responses: {
				200: {
					description: "Matching rollups, newest-first",
					content: {
						"application/json": { schema: RollupListResponseSchema },
					},
				},
				501: { description: "Query engine not configured" },
			},
		}),
		async (c) => {
			if (!query) {
				return c.json(
					{ error: "rollup query engine not configured" } as never,
					501,
				);
			}
			const { service, outcome, since: sinceRaw, limit: limitRaw } =
				c.req.valid("query");
			const since =
				sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
					? new Date(sinceRaw)
					: undefined;
			const limit = limitRaw
				? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 500)
				: 100;
			const records = await query.listRollups({
				service,
				outcome,
				since,
				limit,
			});
			return c.json(
				{ rollups: records, count: records.length } as never,
				200,
			);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/rollups/stats",
			tags: ["rollups"],
			summary: "Aggregate rollups by a dimension",
			request: {
				query: z.object({
					groupBy: z
						.enum(["entry_service", "route", "final_outcome", "error_name"])
						.default("entry_service"),
					since: z.string().datetime().optional(),
					limit: z.string().optional(),
				}),
			},
			responses: {
				200: {
					description: "Aggregate rows sorted by count desc",
					content: {
						"application/json": {
							schema: z.object({ rows: z.array(AggregateRowSchema) }),
						},
					},
				},
				501: { description: "Query engine not configured" },
			},
		}),
		async (c) => {
			if (!query?.aggregateRollups) {
				return c.json(
					{ error: "rollup query engine not configured" } as never,
					501,
				);
			}
			const { groupBy, since: sinceRaw, limit: limitRaw } = c.req.valid("query");
			const since =
				sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
					? new Date(sinceRaw)
					: undefined;
			const limit = limitRaw
				? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 500)
				: 50;
			const rows = await query.aggregateRollups({ groupBy, since, limit });
			return c.json({ rows } as never, 200);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/rollups/{request_id}",
			tags: ["rollups"],
			summary: "Fetch a single rollup by request id",
			request: {
				params: z.object({ request_id: z.string() }),
			},
			responses: {
				200: {
					description: "Rollup",
					content: { "application/json": { schema: WideRollupSchema } },
				},
				404: { description: "No rollup for this request id" },
				501: { description: "Query engine not configured" },
			},
		}),
		async (c) => {
			if (!query) {
				return c.json(
					{ error: "rollup query engine not configured" } as never,
					501,
				);
			}
			const { request_id } = c.req.valid("param");
			const record = await query.getRollup(request_id);
			if (!record) return c.json({ error: "not found" } as never, 404);
			return c.json(record as never, 200);
		},
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/events",
			tags: ["ingest"],
			summary: "Accept a batch of wide events",
			request: {
				body: {
					content: { "application/json": { schema: EventBatchSchema } },
				},
			},
			responses: {
				202: {
					description: "Accepted",
					content: { "application/json": { schema: BatchResponseSchema } },
				},
				207: {
					description: "Partially accepted (some events rejected)",
					content: { "application/json": { schema: BatchResponseSchema } },
				},
				400: {
					description: "Invalid batch",
					content: { "application/json": { schema: BatchResponseSchema } },
				},
			},
		}),
		async (c) => {
			const payload = c.req.valid("json");
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
					} satisfies WideCollectorBatchResponse as never,
					400,
				);
			}
			const result = await acceptCollectorBatch(
				payload as Record<string, unknown>,
				deps,
			);
			return c.json(result.body as never, result.status as 202 | 207 | 400);
		},
	);

	return Object.assign(app, {
		flushExpired(now?: Date) {
			return flushExpiredCollectorRequests(deps, now);
		},
	}) as CollectorApp;
}
