import type { MiddlewareHandler } from "@red/server";
import type { McpConfig } from "./config";

type FetchLike = (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;

export interface IntrospectionResult {
	active: boolean;
	sub?: string;
	scope?: string;
	client_id?: string;
	exp?: number;
}

/**
 * RFC 7662 token introspection against apps/auth. Cached in-process for the
 * lifetime of the token (up to `exp`) so every MCP JSON-RPC message doesn't
 * add a network round-trip.
 */
export class OAuthIntrospector {
	private readonly cache = new Map<
		string,
		{ result: IntrospectionResult; expiresAtMs: number }
	>();
	private readonly config: McpConfig;
	private readonly fetchImpl: FetchLike;

	constructor(config: McpConfig, fetchImpl: FetchLike = fetch) {
		this.config = config;
		this.fetchImpl = fetchImpl;
	}

	async introspect(token: string): Promise<IntrospectionResult> {
		const nowMs = Date.now();
		const cached = this.cache.get(token);
		if (cached && cached.expiresAtMs > nowMs) return cached.result;

		const basic = Buffer.from(
			`${this.config.clientId}:${this.config.clientSecret}`,
		).toString("base64");
		const response = await this.fetchImpl(
			`${this.config.authBaseUrl}/oauth/introspect`,
			{
				method: "POST",
				headers: {
					authorization: `Basic ${basic}`,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: `token=${encodeURIComponent(token)}`,
			},
		);
		if (!response.ok) {
			throw new Error(
				`introspection failed: ${response.status} ${response.statusText}`,
			);
		}
		const result = (await response.json()) as IntrospectionResult;
		if (result.active) {
			const expiresAtMs = result.exp
				? Math.min(result.exp * 1000, nowMs + 60_000)
				: nowMs + 60_000;
			this.cache.set(token, { result, expiresAtMs });
		}
		return result;
	}
}

export function oauthMiddleware(
	config: McpConfig,
	introspector: OAuthIntrospector,
): MiddlewareHandler {
	return async (c, next) => {
		if (config.disableAuth) {
			c.set("oauth", { active: true, sub: "disabled-auth" });
			return next();
		}
		const header = c.req.header("authorization");
		if (!header || !header.toLowerCase().startsWith("bearer ")) {
			return c.json({ error: "missing bearer token" }, 401, {
				"www-authenticate": `Bearer realm="mcp", error="invalid_request"`,
			});
		}
		const token = header.slice(7).trim();
		if (config.adminToken && token === config.adminToken) {
			c.set("oauth", { active: true, sub: "admin", scope: config.requiredScope });
			return next();
		}
		let result: IntrospectionResult;
		try {
			result = await introspector.introspect(token);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			return c.json({ error: `introspection failed: ${message}` }, 503);
		}
		if (!result.active) {
			return c.json({ error: "token is not active" }, 401, {
				"www-authenticate": `Bearer realm="mcp", error="invalid_token"`,
			});
		}
		if (
			config.requiredScope &&
			!(result.scope ?? "").split(/\s+/).includes(config.requiredScope)
		) {
			return c.json({ error: `missing required scope ${config.requiredScope}` }, 403);
		}
		c.set("oauth", result);
		return next();
	};
}
