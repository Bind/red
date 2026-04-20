import {
	buildHealth,
	statusHttpCode,
	type HealthCheck,
} from "@redc/health";
import {
	createObsSinkFromEnv,
	obsMiddleware,
	type EventSink,
} from "@redc/obs";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { apiReference } from "@scalar/hono-api-reference";

export { createRoute, z, OpenAPIHono };

export interface ServiceOptions {
	/** Service name — used by obs, /health, and the OpenAPI `info.title`. */
	name: string;
	/** Semver-ish identifier for the OpenAPI `info.version`. */
	version?: string;
	/** Human-readable description for the OpenAPI `info.description`. */
	description?: string;
	/** Disable the default obs middleware. */
	disableObs?: boolean;
	/** Sink override (mostly for tests). Default: createObsSinkFromEnv. */
	obsSink?: EventSink;
	/** Async health checks — run on every GET /health. */
	healthChecks?: Record<string, () => Promise<HealthCheck> | HealthCheck>;
	/** Path to serve the OpenAPI JSON from. Default "/openapi.json". */
	openApiPath?: string;
	/** Path to serve the Scalar docs UI from. Default "/docs". */
	docsPath?: string;
	/** Extra info to merge into the OpenAPI document. */
	info?: {
		contact?: { name?: string; email?: string; url?: string };
		license?: { name: string; url?: string };
	};
}

/**
 * Creates a Hono app wired with the redc service conventions:
 *   - @redc/obs middleware (request_id, outcome, duration, sink)
 *   - GET /health matching pkg/health's contract
 *   - OpenAPI 3.1 spec at /openapi.json (via @hono/zod-openapi)
 *   - Scalar API reference at /docs
 *   - Standard JSON error + 404 envelopes
 *
 * Routes defined with `createRoute()` get typed request/response + show up
 * in the generated spec. Legacy `app.get()` / `app.post()` still work but
 * don't appear in the spec.
 */
export function createService(options: ServiceOptions): OpenAPIHono {
	const app = new OpenAPIHono();

	if (!options.disableObs) {
		const sink = options.obsSink ?? createObsSinkFromEnv({ service: options.name });
		app.use("*", obsMiddleware({ service: options.name, sink }));
	}

	app.openapi(
		createRoute({
			method: "get",
			path: "/health",
			tags: ["infra"],
			summary: "Liveness + readiness",
			responses: {
				200: {
					description: "Service is healthy",
					content: {
						"application/json": {
							schema: z.object({
								service: z.string(),
								status: z.enum(["ok", "degraded", "error"]),
								commit: z.string(),
								startedAt: z.number().optional(),
								checks: z.record(z.string(), z.any()).optional(),
							}),
						},
					},
				},
				503: {
					description: "Service is degraded or has an erroring dependency",
					content: {
						"application/json": { schema: z.any() },
					},
				},
			},
		}),
		async (c) => {
			const checks = options.healthChecks
				? await resolveChecks(options.healthChecks)
				: undefined;
			const health = buildHealth({ service: options.name, checks });
			return c.json(health, statusHttpCode(health.status));
		},
	);

	app.onError((error, c) => {
		const message = error instanceof Error ? error.message : String(error);
		return c.json(
			{ error: { code: "internal_error", message } },
			500,
		);
	});
	app.notFound((c) =>
		c.json({ error: { code: "not_found", message: "route not found" } }, 404),
	);

	const openApiPath = options.openApiPath ?? "/openapi.json";
	const docsPath = options.docsPath ?? "/docs";

	app.doc31(openApiPath, {
		openapi: "3.1.0",
		info: {
			title: options.name,
			version: options.version ?? "0.0.0",
			description: options.description,
			...options.info,
		},
	});

	app.get(
		docsPath,
		apiReference({
			url: openApiPath,
			theme: "purple",
			pageTitle: `${options.name} · redc API`,
		}),
	);

	return app;
}

async function resolveChecks(
	checks: Record<string, () => Promise<HealthCheck> | HealthCheck>,
): Promise<Record<string, HealthCheck>> {
	const resolved: Record<string, HealthCheck> = {};
	for (const [name, fn] of Object.entries(checks)) {
		try {
			resolved[name] = await fn();
		} catch (error) {
			resolved[name] = {
				status: "error",
				details: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return resolved;
}

/**
 * Fetches multiple services' /openapi.json documents and stitches them
 * into a single OpenAPI 3.1 document. Each service's paths are prefixed
 * with its `prefix` so they don't collide (e.g. "/api", "/rpc").
 */
export async function createCombinedSpec(
	services: Array<{
		name: string;
		baseUrl: string;
		specPath?: string;
		prefix?: string;
	}>,
	info: { title: string; version: string; description?: string },
	fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
	const combined: Record<string, unknown> = {
		openapi: "3.1.0",
		info,
		paths: {},
		components: { schemas: {} },
		tags: [] as Array<Record<string, unknown>>,
	};

	for (const svc of services) {
		const path = svc.specPath ?? "/openapi.json";
		const prefix = (svc.prefix ?? "").replace(/\/$/, "");
		try {
			const res = await fetchImpl(
				`${svc.baseUrl.replace(/\/$/, "")}${path}`,
			);
			if (!res.ok) continue;
			const doc = (await res.json()) as {
				paths?: Record<string, unknown>;
				components?: { schemas?: Record<string, unknown> };
				tags?: Array<Record<string, unknown>>;
			};
			for (const [route, methods] of Object.entries(doc.paths ?? {})) {
				(combined.paths as Record<string, unknown>)[
					`${prefix}${route}`
				] = methods;
			}
			for (const [schema, def] of Object.entries(
				doc.components?.schemas ?? {},
			)) {
				((combined.components as Record<string, Record<string, unknown>>).schemas)[
					`${svc.name}__${schema}`
				] = def;
			}
			if (doc.tags) {
				(combined.tags as Array<Record<string, unknown>>).push(
					...doc.tags.map((tag) => ({
						...tag,
						name: `${svc.name}:${(tag as { name: string }).name}`,
					})),
				);
			}
		} catch {
			// service unreachable — skip; combined spec is best-effort
		}
	}

	return combined;
}

/**
 * Light-touch variant of createService for long-existing services that
 * already have their own obs middleware, /health handler, error handlers,
 * etc. Just mounts /openapi.json (empty-ish) + /docs on top of an existing
 * Hono app so it participates in the combined spec aggregator.
 *
 * Returns an OpenAPIHono you can add typed routes to; those routes will
 * appear in this service's /openapi.json without touching the rest of the
 * service's routing.
 */
export function mountDocs(
	app: import("hono").Hono,
	options: {
		name: string;
		version?: string;
		description?: string;
		openApiPath?: string;
		docsPath?: string;
	},
): OpenAPIHono {
	const docs = new OpenAPIHono();
	const openApiPath = options.openApiPath ?? "/openapi.json";
	const docsPath = options.docsPath ?? "/docs";

	docs.doc31(openApiPath, {
		openapi: "3.1.0",
		info: {
			title: options.name,
			version: options.version ?? "0.0.0",
			description: options.description,
		},
	});
	docs.get(
		docsPath,
		apiReference({
			url: openApiPath,
			theme: "purple",
			pageTitle: `${options.name} · redc API`,
		}),
	);

	app.route("/", docs);
	return docs;
}

/** Mount Scalar against an arbitrary spec URL. Used by the BFF aggregator. */
export function scalarReference(options: {
	specUrl: string;
	pageTitle: string;
}) {
	return apiReference({
		url: options.specUrl,
		theme: "purple",
		pageTitle: options.pageTitle,
	});
}
