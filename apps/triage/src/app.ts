import { createService } from "@redc/server";
import type { Hono } from "hono";
import type { TriageOrchestrator } from "./orchestrator";
import type { RunStore } from "./runs/store";
import { TriageRunRequestSchema } from "./types";

export interface TriageAppDeps {
	store: RunStore;
	orchestrator: TriageOrchestrator;
}

export function createApp(deps: TriageAppDeps): Hono {
	const app = createService({
		name: "triage",
		version: "0.1.0",
		description:
			"Error-rollup triage orchestrator — investigate, approve, propose.",
	});

	// Routes use the existing Hono surface; Zod v4 schemas internal to this
	// workspace aren't compatible with @hono/zod-openapi's v3-typed createRoute,
	// so these paths don't appear in /openapi.json today. Documented in
	// docs/openapi.md.
	app.post("/v1/runs", async (c) => {
		const payload = await c.req.json().catch(() => null);
		const parsed = TriageRunRequestSchema.safeParse(payload);
		if (!parsed.success) {
			return c.json({ error: parsed.error.flatten() }, 400);
		}
		const run = await deps.orchestrator.receive(parsed.data.rollup);
		return c.json({ id: run.id, status: run.status }, 202);
	});

	app.get("/v1/runs", (c) => c.json({ runs: deps.store.list() }));

	app.get("/v1/runs/:id", (c) => {
		const run = deps.store.get(c.req.param("id"));
		if (!run) return c.json({ error: "not found" }, 404);
		return c.json(run);
	});

	app.post("/v1/runs/:id/approve", async (c) => {
		try {
			const run = await deps.orchestrator.approve(c.req.param("id"));
			return c.json(run);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message }, 409);
		}
	});

	app.post("/v1/runs/:id/reject", async (c) => {
		try {
			const run = await deps.orchestrator.reject(c.req.param("id"));
			return c.json(run);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: message }, 409);
		}
	});

	return app;
}
