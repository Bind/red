import { describe, expect, test } from "bun:test";
import { createCombinedSpec, createRoute, createService, z } from "./index";

describe("createService", () => {
	test("GET /health returns the shared contract body", async () => {
		process.env.GIT_COMMIT = "abc123";
		const app = createService({ name: "fixture", version: "0.1.0" });
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			service: string;
			status: string;
			commit: string;
		};
		expect(body.service).toBe("fixture");
		expect(body.status).toBe("ok");
		expect(body.commit).toBe("abc123");
	});

	test("GET /openapi.json lists /health and any added routes", async () => {
		const app = createService({ name: "fixture", version: "0.1.0" });
		app.openapi(
			createRoute({
				method: "get",
				path: "/ping",
				responses: {
					200: {
						description: "pong",
						content: { "application/json": { schema: z.object({ msg: z.string() }) } },
					},
				},
			}),
			(c) => c.json({ msg: "pong" }),
		);
		const res = await app.request("/openapi.json");
		expect(res.status).toBe(200);
		const spec = (await res.json()) as {
			info: { title: string };
			paths: Record<string, unknown>;
		};
		expect(spec.info.title).toBe("fixture");
		expect(spec.paths["/health"]).toBeDefined();
		expect(spec.paths["/ping"]).toBeDefined();
	});

	test("GET /docs serves Scalar HTML", async () => {
		const app = createService({ name: "fixture" });
		const res = await app.request("/docs");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("scalar");
	});

	test("unknown route returns 404 JSON envelope", async () => {
		const app = createService({ name: "fixture" });
		const res = await app.request("/nope");
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("not_found");
	});
});

describe("createCombinedSpec", () => {
	test("merges paths and prefixes each service", async () => {
		const fakeFetch = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/openapi.json") && url.includes("alpha")) {
				return new Response(
					JSON.stringify({
						openapi: "3.1.0",
						info: { title: "alpha", version: "0" },
						paths: { "/foo": { get: { summary: "foo" } } },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("beta")) {
				return new Response(
					JSON.stringify({
						openapi: "3.1.0",
						info: { title: "beta", version: "0" },
						paths: { "/bar": { get: { summary: "bar" } } },
					}),
					{ status: 200 },
				);
			}
			return new Response("missing", { status: 404 });
		}) as unknown as typeof fetch;

		const combined = await createCombinedSpec(
			[
				{ name: "alpha", baseUrl: "http://alpha", prefix: "/alpha" },
				{ name: "beta", baseUrl: "http://beta", prefix: "/beta" },
			],
			{ title: "combined", version: "0.0.0" },
			fakeFetch,
		);

		const paths = (combined as { paths: Record<string, unknown> }).paths;
		expect(paths["/alpha/foo"]).toBeDefined();
		expect(paths["/beta/bar"]).toBeDefined();
	});
});
