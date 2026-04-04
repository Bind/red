import { Hono } from "hono";

type FetchImpl = typeof fetch;

export interface BffConfig {
  port: number;
  apiBaseUrl: string;
  authBaseUrl: string;
  fetchImpl?: FetchImpl;
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
  ];
  for (const key of forwarded) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}

async function proxyJson(c: any, fetchImpl: FetchImpl, targetUrl: string): Promise<Response> {
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: buildForwardHeaders(c.req.raw),
  });
  const text = await upstream.text();
  const json = text ? JSON.parse(text) : null;
  return c.json(json, upstream.status as 200 | 201 | 400 | 401 | 403 | 404 | 500);
}

async function proxyMutation(c: any, fetchImpl: FetchImpl, targetUrl: string): Promise<Response> {
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: buildForwardHeaders(c.req.raw),
  });
  const text = await upstream.text();
  const json = text ? JSON.parse(text) : null;
  return c.json(json, upstream.status as 200 | 201 | 400 | 401 | 403 | 404 | 500);
}

async function proxyText(c: any, fetchImpl: FetchImpl, targetUrl: string): Promise<Response> {
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: buildForwardHeaders(c.req.raw),
  });
  const text = await upstream.text();
  c.header("Content-Type", upstream.headers.get("content-type") ?? "text/plain; charset=utf-8");
  return c.text(text, upstream.status as 200 | 400 | 401 | 403 | 404 | 500);
}

async function proxyStream(c: any, fetchImpl: FetchImpl, targetUrl: string): Promise<Response> {
  const upstream = await fetchImpl(targetUrl, {
    method: c.req.method,
    headers: buildForwardHeaders(c.req.raw),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyResponseHeaders(upstream.headers),
  });
}

async function proxyAuthRequest(c: any, fetchImpl: FetchImpl, authBaseUrl: string): Promise<Response> {
  const incoming = new URL(c.req.url);
  const targetUrl = joinUrl(authBaseUrl, incoming.pathname, incoming.searchParams);
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
  const fetchImpl = config.fetchImpl ?? fetch;

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.all("/api/auth/*", (c) => proxyAuthRequest(c, fetchImpl, config.authBaseUrl));

  const rpc = new Hono()
    .get("/velocity", (c) => {
      const query = new URLSearchParams();
      const hours = c.req.query("hours");
      if (hours) query.set("hours", hours);
      return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/velocity", query));
    })
    .get("/review", (c) => proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/review")))
    .get("/jobs/pending", (c) =>
      proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/jobs/pending"))
    )
    .get("/repos", (c) => proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/repos")))
    .get("/branches", (c) => {
      const query = new URLSearchParams();
      const repo = c.req.query("repo");
      if (repo) query.set("repo", repo);
      return proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, "/api/branches", query));
    })
    .get("/changes/:id", (c) =>
      proxyJson(c, fetchImpl, joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}`))
    )
    .get("/changes/:id/diff", (c) =>
      proxyText(c, fetchImpl, joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/diff`))
    )
    .post("/changes/:id/regenerate-summary", (c) =>
      proxyMutation(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/regenerate-summary`)
      )
    )
    .post("/changes/:id/requeue-summary", (c) =>
      proxyMutation(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/requeue-summary`)
      )
    )
    .get("/changes/:id/sessions", (c) =>
      proxyJson(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/sessions`)
      )
    )
    .get("/changes/:id/agent-events", (c) =>
      proxyStream(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/changes/${c.req.param("id")}/agent-events`)
      )
    )
    .get("/sessions/:id/events", (c) => {
      const query = new URLSearchParams();
      const after = c.req.query("after");
      if (after) query.set("after", after);
      const limit = c.req.query("limit");
      if (limit) query.set("limit", limit);
      return proxyJson(
        c,
        fetchImpl,
        joinUrl(config.apiBaseUrl, `/api/sessions/${c.req.param("id")}/events`, query)
      );
    });

  app.route("/rpc", rpc);
  return app;
}

export type AppType = ReturnType<typeof createApp>;
