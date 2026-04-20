import { createRoute, createService, z } from "@redc/server";
import type { Hono } from "hono";
import { OAuthIntrospector, oauthMiddleware } from "./auth";
import type { McpConfig } from "./config";
import type { McpEndpoint } from "./mcp-server";

export interface McpAppDeps {
	config: McpConfig;
	mcp: McpEndpoint;
	introspector?: OAuthIntrospector;
}

export function createApp(deps: McpAppDeps): Hono {
	const app = createService({
		name: "mcp",
		version: "0.1.0",
		description:
			"Model Context Protocol server over Streamable HTTP. Clients: Claude mobile/desktop, Cursor, etc.",
	});
	const introspector =
		deps.introspector ?? new OAuthIntrospector(deps.config);

	app.use("/mcp", oauthMiddleware(deps.config, introspector));

	app.openapi(
		createRoute({
			method: "post",
			path: "/mcp",
			tags: ["mcp"],
			summary: "MCP JSON-RPC (Streamable HTTP transport)",
			description:
				"Single endpoint for every MCP JSON-RPC message. Stateless mode — no session IDs. Requires Bearer token introspected via apps/auth.",
			security: [{ bearer: [] }],
			responses: {
				200: {
					description: "JSON-RPC response",
					content: { "application/json": { schema: z.any() } },
				},
				401: { description: "Missing or inactive Bearer token" },
				403: { description: "Token lacks the required scope" },
			},
		}),
		async (c) => {
			const response = await deps.mcp.handle(c.req.raw);
			// hono's response typing expects a subset of Response; cast is safe.
			return response as never;
		},
	);

	// GET /mcp is a fallback for SDK inspector GETs; same handler.
	app.get("/mcp", async (c) => {
		const response = await deps.mcp.handle(c.req.raw);
		return response as never;
	});

	return app as Hono;
}
