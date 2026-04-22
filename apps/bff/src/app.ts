import { Hono } from "hono";
import {
  collectHealthReport,
  createObsSinkFromEnv,
  getEnvelope,
  obsMiddleware,
} from "@redc/obs";
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
  grsBaseUrl?: string;
  mcpBaseUrl?: string;
  disableAuth?: boolean;
  fetchImpl?: FetchImpl;
  hostedRepo?: HostedRepoConfig;
  hostedRepoReader?: HostedRepoReader;
}

type ServiceProbeStatus = "ok" | "error" | "unconfigured";

interface ServiceProbeResult {
  service: string;
  url: string | null;
  status: ServiceProbeStatus;
  http_status: number | null;
  latency_ms: number | null;
  checked_at: string;
  body: unknown | null;
  error: string | null;
}

interface StatusReport {
  checked_at: string;
  overall_status: "ok" | "degraded";
  services: ServiceProbeResult[];
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

async function readBestEffortBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

async function fetchSessionExchangeToken(
  request: Request,
  fetchImpl: FetchImpl,
  authBaseUrl: string,
): Promise<{ accessToken: string } | Response> {
  const upstream = await fetchImpl(joinUrl(authBaseUrl, "/session/exchange"), {
    method: "POST",
    headers: buildForwardHeaders(request),
    redirect: "manual",
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    return new Response(text, {
      status: upstream.status,
      headers: copyResponseHeaders(upstream.headers),
    });
  }

  const payload = text ? (JSON.parse(text) as { access_token?: unknown }) : null;
  if (!payload || typeof payload.access_token !== "string") {
    return new Response(JSON.stringify({ error: "invalid_token_response" }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return { accessToken: payload.access_token };
}

async function probeHealthEndpoint(
  fetchImpl: FetchImpl,
  service: string,
  baseUrl: string | undefined,
  requestId: string,
): Promise<ServiceProbeResult> {
  const checkedAt = new Date().toISOString();
  if (!baseUrl) {
    return {
      service,
      url: null,
      status: "unconfigured",
      http_status: null,
      latency_ms: null,
      checked_at: checkedAt,
      body: null,
      error: "service not configured",
    };
  }

  const startedAt = performance.now();
  try {
    const response = await fetchImpl(joinUrl(baseUrl, "/health"), {
      headers: {
        "x-request-id": requestId,
      },
    });
    const body = await readBestEffortBody(response);
    return {
      service,
      url: joinUrl(baseUrl, "/health"),
      status: response.ok ? "ok" : "error",
      http_status: response.status,
      latency_ms: Math.round(performance.now() - startedAt),
      checked_at: checkedAt,
      body,
      error:
        response.ok
          ? null
          : typeof body === "object" && body && "error" in body && typeof body.error === "string"
            ? body.error
            : `healthcheck returned ${response.status}`,
    };
  } catch (error) {
    return {
      service,
      url: joinUrl(baseUrl, "/health"),
      status: "error",
      http_status: null,
      latency_ms: Math.round(performance.now() - startedAt),
      checked_at: checkedAt,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createApp(config: BffConfig) {
  const app = new Hono();
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

  const rpc = new Hono()
    .get("/status", async (c) => {
      const envelope = getEnvelope(c);
      const checkedAt = new Date().toISOString();
      const services = await Promise.all([
        Promise.resolve({
          service: "bff",
          url: "/health",
          status: "ok" as const,
          http_status: 200,
          latency_ms: 0,
          checked_at: checkedAt,
          body: {
            service: "bff",
            status: "ok",
          },
          error: null,
        }),
        probeHealthEndpoint(fetchImpl, "api", config.apiBaseUrl, envelope.requestId),
        probeHealthEndpoint(fetchImpl, "auth", config.authBaseUrl, envelope.requestId),
        probeHealthEndpoint(fetchImpl, "obs", config.obsBaseUrl, envelope.requestId),
        probeHealthEndpoint(fetchImpl, "triage", config.triageBaseUrl, envelope.requestId),
        probeHealthEndpoint(fetchImpl, "grs", config.grsBaseUrl, envelope.requestId),
        probeHealthEndpoint(fetchImpl, "mcp", config.mcpBaseUrl, envelope.requestId),
      ]);
      const report: StatusReport = {
        checked_at: checkedAt,
        overall_status: services.every((service) => service.status !== "error") ? "ok" : "degraded",
        services,
      };
      return c.json(report, report.overall_status === "ok" ? 200 : 503);
    })
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
    .get("/velocity", (c) => {
      const query = new URLSearchParams();
      const hours = c.req.query("hours");
      if (hours) query.set("hours", hours);
      return fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/velocity", query), {
          authorization: `Bearer ${result.accessToken}`,
        });
      });
    })
    .get("/review", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/review"), {
          authorization: `Bearer ${result.accessToken}`,
        });
      })
    )
    .get("/jobs/pending", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/jobs/pending"), {
          authorization: `Bearer ${result.accessToken}`,
        });
      })
    )
    .get("/repos", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/repos"), {
          authorization: `Bearer ${result.accessToken}`,
        });
      })
    )
    .post("/repos", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyMutation(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/repos"), {
          authorization: `Bearer ${result.accessToken}`,
        });
      })
    )
    .get("/branches", (c) => {
      const query = new URLSearchParams();
      const repo = c.req.query("repo");
      if (repo) query.set("repo", repo);
      return fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/branches", query), {
          authorization: `Bearer ${result.accessToken}`,
        });
      });
    })
    .get("/changes/:id", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}`), {
          authorization: `Bearer ${result.accessToken}`,
        });
      })
    )
    .get("/changes/:id/diff", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyText(
          c,
          fetchImpl,
          joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/diff`),
          { authorization: `Bearer ${result.accessToken}` },
        );
      })
    )
    .post("/changes/:id/regenerate-summary", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyMutation(
          c,
          fetchImpl,
          joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/regenerate-summary`),
          { authorization: `Bearer ${result.accessToken}` },
        );
      })
    )
    .post("/changes/:id/requeue-summary", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyMutation(
          c,
          fetchImpl,
          joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/requeue-summary`),
          { authorization: `Bearer ${result.accessToken}` },
        );
      })
    )
    .get("/changes/:id/sessions", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyJson(
          c,
          fetchImpl,
          joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/sessions`),
          { authorization: `Bearer ${result.accessToken}` },
        );
      })
    )
    .get("/changes/:id/agent-events", (c) =>
      fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyStream(
          c,
          fetchImpl,
          joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/agent-events`),
          { authorization: `Bearer ${result.accessToken}` },
        );
      })
    )
    .get("/sessions/:id/events", (c) => {
      const query = new URLSearchParams();
      const after = c.req.query("after");
      if (after) query.set("after", after);
      const limit = c.req.query("limit");
      if (limit) query.set("limit", limit);
      return fetchSessionExchangeToken(c.req.raw, fetchImpl, config.authBaseUrl).then((result) => {
        if (result instanceof Response) return result;
        return proxyJson(
          c,
          fetchImpl,
          joinUrl(config.apiBaseUrl, `/api/sessions/${c.req.param("id")}/events`, query),
          { authorization: `Bearer ${result.accessToken}` },
        );
      });
    });

  // ── triage UI data: wide events + triage runs ───────────────────────────
  // These proxy directly to obs + triage which are internal services; no JWT
  // handoff needed. Session check is gated by config.disableAuth (dev flag).
  const requireSession = async (c: Parameters<typeof fetchSessionExchangeToken>[0] extends Request ? any : never) => {
    if (config.disableAuth) return null;
    const result = await fetchSessionExchangeToken(
      c.req.raw,
      fetchImpl,
      config.authBaseUrl,
    );
    return result instanceof Response ? result : null;
  };

  rpc
    .get("/rollups", async (c) => {
      if (!config.obsBaseUrl)
        return c.json({ error: "obs backend not configured" }, 503);
      const gate = await requireSession(c);
      if (gate) return gate;
      const query = new URLSearchParams();
      for (const key of ["service", "outcome", "since", "limit"] as const) {
        const value = c.req.query(key);
        if (value) query.set(key, value);
      }
      return proxyJson(c, fetchImpl, joinUrl(config.obsBaseUrl, "/v1/rollups", query));
    })
    .get("/rollups/:request_id", async (c) => {
      if (!config.obsBaseUrl)
        return c.json({ error: "obs backend not configured" }, 503);
      const gate = await requireSession(c);
      if (gate) return gate;
      const id = encodeURIComponent(c.req.param("request_id"));
      return proxyJson(c, fetchImpl, joinUrl(config.obsBaseUrl, `/v1/rollups/${id}`));
    })
    .get("/triage/runs", async (c) => {
      if (!config.triageBaseUrl)
        return c.json({ error: "triage backend not configured" }, 503);
      const gate = await requireSession(c);
      if (gate) return gate;
      return proxyJson(c, fetchImpl, joinUrl(config.triageBaseUrl, "/v1/runs"));
    });

  app.route("/rpc", rpc);
  return app;
}

export type AppType = ReturnType<typeof createApp>;
