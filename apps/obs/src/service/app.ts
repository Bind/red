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
