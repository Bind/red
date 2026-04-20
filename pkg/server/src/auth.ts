/**
 * Shared auth middlewares for redc services.
 *
 * requireBearer   — OAuth 2.1 Bearer token, introspected against apps/auth.
 *                   Populates c.var.bearer with the introspection result.
 * requireSession  — Better Auth session cookie → JWT exchange. Populates
 *                   c.var.session with { accessToken, claims }.
 * publicRoute     — helper that tags a createRoute config as explicitly
 *                   public (empty `security`) so the generated spec is
 *                   loud about which routes don't require auth.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { RouteConfig } from "@hono/zod-openapi";

// ── Bearer token ───────────────────────────────────────────────────────────

export interface IntrospectionResult {
	active: boolean;
	sub?: string;
	scope?: string;
	client_id?: string;
	exp?: number;
}

export interface BearerOptions {
	authBaseUrl: string;
	/** client_id of the service performing the introspection call. */
	clientId: string;
	/** client_secret paired with clientId. */
	clientSecret: string;
	/** Required OAuth scope on the inbound token. Empty string = any scope. */
	scope?: string;
	/** When true, skips introspection entirely. Dev-only escape hatch. */
	disable?: boolean;
	/** Override for tests. */
	fetchImpl?: typeof fetch;
	/** Override for tests (defaults to Date.now). */
	now?: () => number;
}

export class BearerIntrospector {
	private readonly cache = new Map<
		string,
		{ result: IntrospectionResult; expiresAtMs: number }
	>();
	private readonly options: Required<
		Pick<BearerOptions, "authBaseUrl" | "clientId" | "clientSecret">
	> &
		Pick<BearerOptions, "fetchImpl" | "now">;

	constructor(options: BearerOptions) {
		this.options = {
			authBaseUrl: options.authBaseUrl,
			clientId: options.clientId,
			clientSecret: options.clientSecret,
			fetchImpl: options.fetchImpl,
			now: options.now,
		};
	}

	async introspect(token: string): Promise<IntrospectionResult> {
		const now = this.options.now ?? (() => Date.now());
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const nowMs = now();
		const cached = this.cache.get(token);
		if (cached && cached.expiresAtMs > nowMs) return cached.result;

		const basic = Buffer.from(
			`${this.options.clientId}:${this.options.clientSecret}`,
		).toString("base64");
		const response = await fetchImpl(
			`${this.options.authBaseUrl}/oauth/introspect`,
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

export function requireBearer(options: BearerOptions): MiddlewareHandler {
	const introspector = new BearerIntrospector(options);
	return async (c, next) => {
		if (options.disable) {
			c.set("bearer", { active: true, sub: "disabled-auth" });
			return next();
		}
		const header = c.req.header("authorization");
		if (!header || !header.toLowerCase().startsWith("bearer ")) {
			return c.json({ error: "missing bearer token" }, 401, {
				"www-authenticate": `Bearer realm="redc", error="invalid_request"`,
			});
		}
		const token = header.slice(7).trim();
		let result: IntrospectionResult;
		try {
			result = await introspector.introspect(token);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json({ error: `introspection failed: ${message}` }, 503);
		}
		if (!result.active) {
			return c.json({ error: "token is not active" }, 401, {
				"www-authenticate": `Bearer realm="redc", error="invalid_token"`,
			});
		}
		if (
			options.scope &&
			!(result.scope ?? "").split(/\s+/).includes(options.scope)
		) {
			return c.json(
				{ error: `missing required scope ${options.scope}` },
				403,
			);
		}
		c.set("bearer", result);
		return next();
	};
}

// ── Session → JWT exchange ─────────────────────────────────────────────────

export interface SessionResult {
	accessToken: string;
	claims?: Record<string, unknown>;
}

export interface SessionOptions {
	authBaseUrl: string;
	/** When true, populates a stub session without calling upstream. Dev-only. */
	disable?: boolean;
	/** Override for tests. */
	fetchImpl?: typeof fetch;
}

const SESSION_FORWARD_HEADERS = [
	"accept",
	"authorization",
	"content-type",
	"cookie",
	"origin",
	"x-request-id",
];

function buildSessionForwardHeaders(request: Request): Headers {
	const headers = new Headers();
	for (const key of SESSION_FORWARD_HEADERS) {
		const value = request.headers.get(key);
		if (value) headers.set(key, value);
	}
	return headers;
}

export function requireSession(options: SessionOptions): MiddlewareHandler {
	return async (c, next) => {
		if (options.disable) {
			c.set("session", {
				accessToken: "disabled-auth",
				claims: { sub: "disabled-auth" },
			} satisfies SessionResult);
			return next();
		}
		const fetchImpl = options.fetchImpl ?? fetch;
		const upstream = await fetchImpl(
			`${options.authBaseUrl}/session/exchange`,
			{
				method: "POST",
				headers: buildSessionForwardHeaders(c.req.raw),
				redirect: "manual",
			},
		);
		if (!upstream.ok) {
			return c.json({ error: "session required" }, upstream.status || 401, {
				"www-authenticate": `Cookie realm="redc"`,
			});
		}
		const raw = (await upstream.json()) as {
			accessToken?: string;
			access_token?: string;
			claims?: Record<string, unknown>;
		};
		const accessToken = raw.accessToken ?? raw.access_token;
		if (!accessToken || typeof accessToken !== "string") {
			return c.json({ error: "session exchange returned no token" }, 502);
		}
		c.set("session", { accessToken, claims: raw.claims } satisfies SessionResult);
		return next();
	};
}

// ── Public route marker ────────────────────────────────────────────────────

/**
 * Tags a route config as explicitly public so the OpenAPI spec is loud about
 * which endpoints intentionally don't require auth.
 */
export function publicRoute<T extends RouteConfig>(route: T): T {
	return { ...route, security: [] };
}

// ── Context accessors ──────────────────────────────────────────────────────

export function getBearer(c: Context): IntrospectionResult | undefined {
	return c.get("bearer") as IntrospectionResult | undefined;
}

export function getSession(c: Context): SessionResult | undefined {
	return c.get("session") as SessionResult | undefined;
}
