import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import type { McpConfig } from "./config";
import { createMcpEndpoint } from "./mcp-server";

function baseConfig(overrides: Partial<McpConfig> = {}): McpConfig {
	return {
		port: 0,
		authBaseUrl: "http://auth.test",
		clientId: "mcp-client",
		clientSecret: "mcp-secret",
		requiredScope: "mcp:read",
		disableAuth: false,
		...overrides,
	};
}

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

describe("mcp app auth", () => {
	test("POST /mcp without bearer → 401", async () => {
		const mcp = await createMcpEndpoint();
		const app = createApp({ config: baseConfig(), mcp });
		const res = await app.request("/mcp", { method: "POST" });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Bearer");
	});

	test("MCP_DISABLE_AUTH=true bypasses introspection", async () => {
		const mcp = await createMcpEndpoint();
		const app = createApp({ config: baseConfig({ disableAuth: true }), mcp });
		// No Authorization header — should still pass auth and hit MCP (which
		// may reject the empty body with its own error, not a 401).
		const res = await app.request("/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: "",
		});
		expect(res.status).not.toBe(401);
	});
});
