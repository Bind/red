import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { OAuthIntrospector } from "./auth";
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

function fakeIntrospector(
	tokens: Record<string, { active: boolean; scope?: string }>,
	onCall: (token: string) => void = () => {},
): OAuthIntrospector {
	const fakeFetch = async (_url: RequestInfo | URL | Request, init?: RequestInit) => {
		const body = String((init?.body ?? "") as string);
		const token = new URLSearchParams(body).get("token") ?? "";
		onCall(token);
		const result = tokens[token] ?? { active: false };
		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return new OAuthIntrospector(baseConfig(), fakeFetch);
}

describe("mcp app auth", () => {
	test("POST /mcp without bearer → 401", async () => {
		const mcp = await createMcpEndpoint();
		const app = createApp({
			config: baseConfig(),
			mcp,
			introspector: fakeIntrospector({}),
		});
		const res = await app.request("/mcp", { method: "POST" });
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Bearer");
	});

	test("POST /mcp with inactive token → 401", async () => {
		const mcp = await createMcpEndpoint();
		const app = createApp({
			config: baseConfig(),
			mcp,
			introspector: fakeIntrospector({ "bad-token": { active: false } }),
		});
		const res = await app.request("/mcp", {
			method: "POST",
			headers: { authorization: "Bearer bad-token" },
		});
		expect(res.status).toBe(401);
	});

	test("POST /mcp with active token but missing scope → 403", async () => {
		const mcp = await createMcpEndpoint();
		const app = createApp({
			config: baseConfig(),
			mcp,
			introspector: fakeIntrospector({
				"no-scope": { active: true, scope: "other:scope" },
			}),
		});
		const res = await app.request("/mcp", {
			method: "POST",
			headers: { authorization: "Bearer no-scope" },
		});
		expect(res.status).toBe(403);
	});

	test("MCP_DISABLE_AUTH=true bypasses introspection", async () => {
		const mcp = await createMcpEndpoint();
		let introspected = false;
		const app = createApp({
			config: baseConfig({ disableAuth: true }),
			mcp,
			introspector: fakeIntrospector({}, () => {
				introspected = true;
			}),
		});
		// No Authorization header — should still pass auth and hit MCP (which
		// will reject the empty body with its own error, not a 401).
		const res = await app.request("/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: "",
		});
		expect(res.status).not.toBe(401);
		expect(introspected).toBe(false);
	});
});
