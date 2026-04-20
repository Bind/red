import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { publicRoute, requireBearer, requireSession } from "./auth";

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...init.headers },
	});
}

describe("requireBearer", () => {
	test("401 without an Authorization header", async () => {
		const app = new Hono();
		app.use(
			"/protected",
			requireBearer({
				authBaseUrl: "http://auth",
				clientId: "x",
				clientSecret: "y",
				fetchImpl: async () => json({ active: true }),
			}),
		);
		app.get("/protected", (c) => c.text("ok"));
		const res = await app.request("/protected");
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain("Bearer");
	});

	test("403 when required scope is missing", async () => {
		const app = new Hono();
		app.use(
			"/protected",
			requireBearer({
				authBaseUrl: "http://auth",
				clientId: "x",
				clientSecret: "y",
				scope: "needed:scope",
				fetchImpl: async () =>
					json({ active: true, scope: "other:scope" }),
			}),
		);
		app.get("/protected", (c) => c.text("ok"));
		const res = await app.request("/protected", {
			headers: { authorization: "Bearer abc" },
		});
		expect(res.status).toBe(403);
	});

	test("lets the request through when active and scope matches", async () => {
		const app = new Hono();
		app.use(
			"/protected",
			requireBearer({
				authBaseUrl: "http://auth",
				clientId: "x",
				clientSecret: "y",
				scope: "ok:scope",
				fetchImpl: async () =>
					json({ active: true, scope: "ok:scope other:scope" }),
			}),
		);
		app.get("/protected", (c) => c.text("ok"));
		const res = await app.request("/protected", {
			headers: { authorization: "Bearer abc" },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	test("disable flag skips introspection", async () => {
		let called = false;
		const app = new Hono();
		app.use(
			"/protected",
			requireBearer({
				authBaseUrl: "http://auth",
				clientId: "x",
				clientSecret: "y",
				disable: true,
				fetchImpl: async () => {
					called = true;
					return json({ active: true });
				},
			}),
		);
		app.get("/protected", (c) => c.text("ok"));
		const res = await app.request("/protected");
		expect(res.status).toBe(200);
		expect(called).toBe(false);
	});

	test("introspection result is cached between requests", async () => {
		let calls = 0;
		const app = new Hono();
		app.use(
			"/protected",
			requireBearer({
				authBaseUrl: "http://auth",
				clientId: "x",
				clientSecret: "y",
				fetchImpl: async () => {
					calls += 1;
					return json({ active: true, exp: Math.floor(Date.now() / 1000) + 60 });
				},
			}),
		);
		app.get("/protected", (c) => c.text("ok"));
		for (let i = 0; i < 3; i += 1) {
			await app.request("/protected", {
				headers: { authorization: "Bearer same-token" },
			});
		}
		expect(calls).toBe(1);
	});
});

describe("requireSession", () => {
	test("401 when upstream /session/exchange rejects", async () => {
		const app = new Hono();
		app.use(
			"/rpc/me",
			requireSession({
				authBaseUrl: "http://auth",
				fetchImpl: async () => new Response("no", { status: 401 }),
			}),
		);
		app.get("/rpc/me", (c) => c.text("ok"));
		const res = await app.request("/rpc/me");
		expect(res.status).toBe(401);
	});

	test("exposes the exchanged JWT via c.var.session", async () => {
		const app = new Hono();
		app.use(
			"/rpc/me",
			requireSession({
				authBaseUrl: "http://auth",
				fetchImpl: async () =>
					json({ accessToken: "jwt.abc", claims: { sub: "alice" } }),
			}),
		);
		app.get("/rpc/me", (c) => {
			const session = c.get("session" as never) as
				| { accessToken: string; claims?: Record<string, unknown> }
				| undefined;
			return c.json({ token: session?.accessToken });
		});
		const res = await app.request("/rpc/me");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ token: "jwt.abc" });
	});

	test("disable flag populates a stub session", async () => {
		const app = new Hono();
		app.use(
			"/rpc/me",
			requireSession({ authBaseUrl: "http://auth", disable: true }),
		);
		app.get("/rpc/me", (c) => c.text("ok"));
		const res = await app.request("/rpc/me");
		expect(res.status).toBe(200);
	});
});

describe("publicRoute", () => {
	test("tags the route with an empty security array", () => {
		const tagged = publicRoute({
			method: "get",
			path: "/health",
			responses: { 200: { description: "ok" } },
		});
		expect(tagged.security).toEqual([]);
	});
});
