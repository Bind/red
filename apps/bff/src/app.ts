import { Hono } from "hono";
import {
  collectHealthReport,
  createObsSinkFromEnv,
  getEnvelope,
  obsMiddleware,
} from "@redc/obs";
import {
  createCombinedSpec,
  getSession,
  mountDocs,
  requireSession,
  scalarReference,
} from "@redc/server";
import {
  createHostedRepoReader,
  splitHostedRepoId,
  type HostedRepoConfig,
  type HostedRepoReader,
} from "./hosted-repo";

type FetchImpl = (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BffConfig {
  port: number;
  apiBaseUrl: string;
  authBaseUrl: string;
  obsBaseUrl?: string;
  triageBaseUrl?: string;
  mcpBaseUrl?: string;
  disableAuth?: boolean;
  fetchImpl?: FetchImpl;
  hostedRepo?: HostedRepoConfig;
  hostedRepoReader?: HostedRepoReader;
}

function joinUrl(baseUrl: string, path: string, query?: URLSearchParams): string {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
  if (query) {
    url.search = query.toString();
  }
  return url.toString();
}

function copyResponseHeaders(headers: Headers): Headers {
  const copied = new Headers();
  const allowed = [
    "cache-control",
    "connection",
    "content-type",
    "set-cookie",
    "www-authenticate",
  ];
  for (const [key, value] of headers.entries()) {
    if (allowed.includes(key.toLowerCase())) {
      copied.append(key, value);
    }
  }
  return copied;
}

function buildForwardHeaders(request: Request): Headers {
  const headers = new Headers();
  const forwarded = [
    "accept",
    "authorization",
    "content-type",
    "cookie",
    "last-event-id",
    "origin",
    "x-request-id",
  ];
  for (const key of forwarded) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}

function addHeaders(base: Headers, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return headers;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function readForwardBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  return request.arrayBuffer();
}

async function proxyJson(
  c: any,
  fetchImpl: FetchImpl,
  targetUrl: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const body = await readForwardBody(c.req.raw);
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: addHeaders(buildForwardHeaders(c.req.raw), extraHeaders),
    body,
  });
  const json = await readJsonBody(upstream);
  return c.json(json, upstream.status as 200 | 201 | 400 | 401 | 403 | 404 | 500);
}

async function proxyMutation(
  c: any,
  fetchImpl: FetchImpl,
  targetUrl: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const body = await readForwardBody(c.req.raw);
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: addHeaders(buildForwardHeaders(c.req.raw), extraHeaders),
    body,
  });
  const json = await readJsonBody(upstream);
  return c.json(json, upstream.status as 200 | 201 | 400 | 401 | 403 | 404 | 500);
}

async function proxyText(
  c: any,
  fetchImpl: FetchImpl,
  targetUrl: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const body = await readForwardBody(c.req.raw);
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: addHeaders(buildForwardHeaders(c.req.raw), extraHeaders),
    body,
  });
  const text = await upstream.text();
  c.header("Content-Type", upstream.headers.get("content-type") ?? "text/plain; charset=utf-8");
  return c.text(text, upstream.status as 200 | 400 | 401 | 403 | 404 | 500);
}

async function proxyStream(
  c: any,
  fetchImpl: FetchImpl,
  targetUrl: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const body = await readForwardBody(c.req.raw);
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: addHeaders(buildForwardHeaders(c.req.raw), extraHeaders),
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyResponseHeaders(upstream.headers),
  });
}

async function proxyAuthRequest(c: any, fetchImpl: FetchImpl, targetUrl: string): Promise<Response> {
  const body =
    c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await c.req.raw.arrayBuffer();
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: buildForwardHeaders(c.req.raw),
    body,
    redirect: "manual",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyResponseHeaders(upstream.headers),
  });
}

export function createApp(config: BffConfig) {
  const app = new Hono();
  mountDocs(app, {
    name: "bff",
    version: "0.1.0",
    description: "Backend-for-frontend: session → JWT exchange, upstream proxies, combined OpenAPI spec.",
  });
  const startedAt = Date.now();
  const fetchImpl = config.fetchImpl ?? fetch;
  const hostedRepoReader =
    config.hostedRepoReader
    ?? (config.hostedRepo ? createHostedRepoReader(config.hostedRepo, fetchImpl) : null);

  app.use("*", obsMiddleware({ service: "bff", sink: createObsSinkFromEnv({ service: "bff" }) }));

  app.get("/health", async (c) => {
    const envelope = getEnvelope(c);
    envelope.set({
      route: {
        name: "health",
      },
    });
    const report = await collectHealthReport({
      service: "bff",
      startedAtMs: startedAt,
      checks: {
        auth: async () => {
          const response = await fetchImpl(joinUrl(config.authBaseUrl, "/health"), {
            headers: {
              "x-request-id": envelope.requestId,
            },
          });
          if (!response.ok) {
            throw new Error(`auth upstream unhealthy: ${response.status}`);
          }
          const body = (await response.json()) as { status?: string };
          return {
            upstream: config.authBaseUrl,
            reported_status: body.status ?? "ok",
          };
        },
        api: async () => {
          const response = await fetchImpl(joinUrl(config.apiBaseUrl, "/health"), {
            headers: {
              "x-request-id": envelope.requestId,
            },
          });
          if (!response.ok) {
            throw new Error(`api upstream unhealthy: ${response.status}`);
          }
          const body = (await response.json()) as { status?: string };
          return {
            upstream: config.apiBaseUrl,
            reported_status: body.status ?? "ok",
          };
        },
      },
    });
    envelope.set({
      health: {
        status: report.status,
        checks: report.checks as Record<string, unknown>,
      },
    });
    c.header("x-request-id", envelope.requestId);
    return c.json(report, report.status === "ok" ? 200 : 503);
  });

  app.all("/api/auth/*", (c) => {
    const incoming = new URL(c.req.url);
    return proxyAuthRequest(
      c,
      fetchImpl,
      joinUrl(config.authBaseUrl, incoming.pathname, incoming.searchParams),
    );
  });

  // Shared session middleware — every previously-inline fetchSessionExchangeToken
  // call site now mounts this gate and reads the JWT off c.var.session.
  const sessionGate = requireSession({
    authBaseUrl: config.authBaseUrl,
    disable: config.disableAuth,
    fetchImpl,
  });

  const rpc = new Hono()
    .get("/me", (c) => proxyAuthRequest(c, fetchImpl, joinUrl(config.authBaseUrl, "/me")))
    .get("/dev/magic-link", (c) => {
      const query = new URLSearchParams();
      const email = c.req.query("email");
      if (email) query.set("email", email);
      return proxyAuthRequest(
        c,
        fetchImpl,
        joinUrl(config.authBaseUrl, "/__test__/mailbox/latest", query),
      );
    })
    .post("/auth/login-attempts", (c) =>
      proxyAuthRequest(c, fetchImpl, joinUrl(config.authBaseUrl, "/login-attempts"))
    )
    .get("/auth/login-attempts/:id", (c) =>
      proxyAuthRequest(
        c,
        fetchImpl,
        joinUrl(config.authBaseUrl, `/login-attempts/${c.req.param("id")}`),
      )
    )
    .post("/auth/login-attempts/redeem", (c) =>
      proxyAuthRequest(c, fetchImpl, joinUrl(config.authBaseUrl, "/login-attempts/redeem"))
    )
    .post("/auth/magic-link/complete", (c) =>
      proxyAuthRequest(c, fetchImpl, joinUrl(config.authBaseUrl, "/magic-link/complete"))
    )
    .post("/auth/user/two-factor/enroll", (c) =>
      proxyAuthRequest(c, fetchImpl, joinUrl(config.authBaseUrl, "/user/two-factor/enroll"))
    )
    .post("/auth/user/two-factor/verify", (c) =>
      proxyAuthRequest(c, fetchImpl, joinUrl(config.authBaseUrl, "/user/two-factor/verify"))
    )
    .post("/auth/user/onboarding/complete", (c) =>
      proxyAuthRequest(c, fetchImpl, joinUrl(config.authBaseUrl, "/user/onboarding/complete"))
    )
    .get("/app/hosted-repo", async (c) => {
      if (!hostedRepoReader) {
        return c.json({ error: "Hosted repo app is not configured" }, 404);
      }
      return c.json(await hostedRepoReader.readSnapshot());
    })
    .get("/app/hosted-repo/commits/:sha/diff", async (c) => {
      if (!config.hostedRepo) {
        return c.json({ error: "Hosted repo app is not configured" }, 404);
      }
      const envelope = getEnvelope(c);
      const { owner, name } = splitHostedRepoId(config.hostedRepo.repoId);
      const sha = encodeURIComponent(c.req.param("sha"));
      const response = await fetchImpl(
        new URL(`/api/repos/${owner}/${name}/commits/${sha}/diff`, config.apiBaseUrl),
        {
          headers: {
            "x-request-id": envelope.requestId,
          },
        },
      );
      if (!response.ok) {
        return c.text(await response.text().catch(() => "Unable to load commit diff"), response.status as any);
      }
      return c.newResponse(response.body, {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") ?? "text/plain; charset=utf-8",
        },
      });
    })
    .get("/velocity", sessionGate, (c) => {
      const query = new URLSearchParams();
      const hours = c.req.query("hours");
      if (hours) query.set("hours", hours);
      const { accessToken } = getSession(c)!;
      return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/velocity", query), {
        authorization: `Bearer ${accessToken}`,
      });
    })
    .get("/review", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/review"), {
        authorization: `Bearer ${accessToken}`,
      });
    })
    .get("/jobs/pending", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/jobs/pending"), {
        authorization: `Bearer ${accessToken}`,
      });
    })
    .get("/repos", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/repos"), {
        authorization: `Bearer ${accessToken}`,
      });
    })
    .post("/repos", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyMutation(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/repos"), {
        authorization: `Bearer ${accessToken}`,
      });
    })
    .get("/branches", sessionGate, (c) => {
      const query = new URLSearchParams();
      const repo = c.req.query("repo");
      if (repo) query.set("repo", repo);
      const { accessToken } = getSession(c)!;
      return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/branches", query), {
        authorization: `Bearer ${accessToken}`,
      });
    })
    .get("/changes/:id", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyJson(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}`),
        { authorization: `Bearer ${accessToken}` },
      );
    })
    .get("/changes/:id/diff", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyText(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/diff`),
        { authorization: `Bearer ${accessToken}` },
      );
    })
    .post("/changes/:id/regenerate-summary", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyMutation(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/regenerate-summary`),
        { authorization: `Bearer ${accessToken}` },
      );
    })
    .post("/changes/:id/requeue-summary", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyMutation(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/requeue-summary`),
        { authorization: `Bearer ${accessToken}` },
      );
    })
    .get("/changes/:id/sessions", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyJson(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/sessions`),
        { authorization: `Bearer ${accessToken}` },
      );
    })
    .get("/changes/:id/agent-events", sessionGate, (c) => {
      const { accessToken } = getSession(c)!;
      return proxyStream(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/agent-events`),
        { authorization: `Bearer ${accessToken}` },
      );
    })
    .get("/sessions/:id/events", sessionGate, (c) => {
      const query = new URLSearchParams();
      const after = c.req.query("after");
      if (after) query.set("after", after);
      const limit = c.req.query("limit");
      if (limit) query.set("limit", limit);
      const { accessToken } = getSession(c)!;
      return proxyJson(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/sessions/${c.req.param("id")}/events`, query),
        { authorization: `Bearer ${accessToken}` },
      );
    });

  // ── triage UI data: wide events + triage runs ───────────────────────────
  // obs/triage are internal services with no JWT handoff, so these routes
  // just gate on session presence via the shared sessionGate middleware.
  rpc
    .get("/rollups", sessionGate, (c) => {
      if (!config.obsBaseUrl)
        return c.json({ error: "obs backend not configured" }, 503);
      const query = new URLSearchParams();
      for (const key of ["service", "outcome", "since", "limit"] as const) {
        const value = c.req.query(key);
        if (value) query.set(key, value);
      }
      return proxyJson(c, fetchImpl, joinUrl(config.obsBaseUrl, "/v1/rollups", query));
    })
    .get("/rollups/:request_id", sessionGate, (c) => {
      if (!config.obsBaseUrl)
        return c.json({ error: "obs backend not configured" }, 503);
      const id = encodeURIComponent(c.req.param("request_id"));
      return proxyJson(c, fetchImpl, joinUrl(config.obsBaseUrl, `/v1/rollups/${id}`));
    })
    .get("/triage/runs", sessionGate, (c) => {
      if (!config.triageBaseUrl)
        return c.json({ error: "triage backend not configured" }, 503);
      return proxyJson(c, fetchImpl, joinUrl(config.triageBaseUrl, "/v1/runs"));
    });

  app.route("/rpc", rpc);

  // Combined OpenAPI spec — aggregates every service's /openapi.json.
  // Envoy routes /api/openapi.json + /api/docs to these endpoints.
  app.get("/rpc/openapi.json", async (c) => {
    const spec = await createCombinedSpec(
      [
        { name: "api",    baseUrl: config.apiBaseUrl,                     prefix: "/api" },
        { name: "auth",   baseUrl: config.authBaseUrl,                    prefix: "/auth" },
        { name: "bff",    baseUrl: `http://127.0.0.1:${config.port}`,     prefix: "/rpc" },
        ...(config.obsBaseUrl    ? [{ name: "obs",    baseUrl: config.obsBaseUrl,    prefix: "/obs" }]    : []),
        ...(config.triageBaseUrl ? [{ name: "triage", baseUrl: config.triageBaseUrl, prefix: "/triage" }] : []),
        ...(config.mcpBaseUrl    ? [{ name: "mcp",    baseUrl: config.mcpBaseUrl,    prefix: "/mcp" }]    : []),
      ],
      {
        title: "redc",
        version: "0.1.0",
        description: "Combined OpenAPI spec across every redc service.",
      },
      fetchImpl,
    );
    return c.json(spec);
  });

  app.get(
    "/rpc/docs",
    scalarReference({
      specUrl: "/rpc/openapi.json",
      pageTitle: "redc · API reference",
    }),
  );

  return app;
}

export type AppType = ReturnType<typeof createApp>;
