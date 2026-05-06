import { buildHealth, statusHttpCode } from "@red/health";
import { Hono, createHttpLogger } from "@red/server";
import { OAuthIntrospector, oauthMiddleware } from "./auth";
import type { McpConfig } from "./config";
import type { McpEndpoint } from "./mcp-server";

export interface McpAppDeps {
	config: McpConfig;
	mcp: McpEndpoint;
	introspector?: OAuthIntrospector;
}

export function createApp(deps: McpAppDeps) {
	const introspector = deps.introspector ?? new OAuthIntrospector(deps.config);

	return new Hono()
		.use("*", createHttpLogger({ service: "mcp", app: "red" }))
		.get("/health", (c) => {
			const health = buildHealth({ service: "mcp" });
			return c.json(health, statusHttpCode(health.status));
		})
		// /mcp is the single Streamable HTTP endpoint — POSTs carry JSON-RPC
		// requests; SDK-side handles optional SSE upgrades.
		.use("/mcp", oauthMiddleware(deps.config, introspector))
		.all("/mcp", (c) => deps.mcp.handle(c.req.raw));
}

export type AppRouter = ReturnType<typeof createApp>;
