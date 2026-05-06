type FetchImpl = (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;

export type Upstream = "api" | "auth" | "obs" | "triage" | "grs" | "mcp";
export type AuthMode = "jwt" | "cookie" | "session" | "none";
export type BodyMode = "json" | "text" | "stream";

export interface ClientConfig {
  apiBaseUrl: string;
  authBaseUrl: string;
  obsBaseUrl?: string;
  triageBaseUrl?: string;
  grsBaseUrl?: string;
  mcpBaseUrl?: string;
  disableAuth?: boolean;
}

export interface ClientDeps {
  config: ClientConfig;
  fetchImpl: FetchImpl;
}

export type ClientFactory = (c: any) => RouteBuilder;

/**
 * Per-service client factories. Each preset bakes in the upstream + auth
 * mode + body mode that match how that upstream is actually used today.
 * All presets remain overridable via the chain (e.g. `auth(c).auth("none")`).
 */

export function makeApi(deps: ClientDeps): ClientFactory {
  return (c: any) => new RouteBuilder(c, deps.config, deps.fetchImpl);
}

export function makeAuth(deps: ClientDeps): ClientFactory {
  return (c: any) =>
    new RouteBuilder(c, deps.config, deps.fetchImpl).to("auth").auth("cookie").as("stream");
}

export function makeObs(deps: ClientDeps): ClientFactory {
  return (c: any) =>
    new RouteBuilder(c, deps.config, deps.fetchImpl).to("obs").auth("session");
}

export function makeTriage(deps: ClientDeps): ClientFactory {
  return (c: any) =>
    new RouteBuilder(c, deps.config, deps.fetchImpl).to("triage").auth("session");
}

class RouteBuilder {
  private _upstream: Upstream = "api";
  private _path: string | undefined;
  private _query = new URLSearchParams();
  private _auth: AuthMode = "jwt";
  private _bodyMode: BodyMode = "json";
  private _onError: ((err: unknown) => Response | Promise<Response>) | undefined;

  constructor(
    private c: any,
    private config: ClientConfig,
    private fetchImpl: FetchImpl,
  ) {}

  to(upstream: Upstream): this {
    this._upstream = upstream;
    return this;
  }

  path(target: string): this {
    this._path = target;
    return this;
  }

  auth(mode: AuthMode): this {
    this._auth = mode;
    return this;
  }

  as(mode: BodyMode): this {
    this._bodyMode = mode;
    return this;
  }

  query(allowlist: readonly string[]): this {
    for (const key of allowlist) {
      const value = this.c.req.query(key);
      if (value) this._query.set(key, value);
    }
    return this;
  }

  queryAdd(extra: Record<string, string | undefined>): this {
    for (const [key, value] of Object.entries(extra)) {
      if (value) this._query.set(key, value);
    }
    return this;
  }

  onError(fn: (err: unknown) => Response | Promise<Response>): this {
    this._onError = fn;
    return this;
  }

  async send(): Promise<Response> {
    const baseUrl = this.upstreamBaseUrl();
    if (!baseUrl) {
      return this.c.json({ error: `${this._upstream} backend not configured` }, 503);
    }
    if (!this._path) {
      throw new Error("RouteBuilder: .path() is required before .send()");
    }

    const targetUrl = joinUrl(baseUrl, this._path, this._query);
    const forwardHeaders = buildForwardHeaders(this.c.req.raw);

    if (this._auth === "jwt") {
      const exchanged = await fetchSessionExchangeToken(
        this.c.req.raw,
        this.fetchImpl,
        this.config.authBaseUrl,
      );
      if (exchanged instanceof Response) return exchanged;
      forwardHeaders.set("authorization", `Bearer ${exchanged.accessToken}`);
    } else if (this._auth === "session" && !this.config.disableAuth) {
      const gate = await fetchSessionExchangeToken(
        this.c.req.raw,
        this.fetchImpl,
        this.config.authBaseUrl,
      );
      if (gate instanceof Response) return gate;
    }

    const body = await readForwardBody(this.c.req.raw);
    const init: RequestInit = {
      method: this.c.req.method,
      headers: forwardHeaders,
      body,
    };
    if (this._auth === "cookie") {
      init.redirect = "manual";
    }

    try {
      const upstream = await this.fetchImpl(targetUrl, init);
      return await this.shape(upstream);
    } catch (err) {
      if (this._onError) return await this._onError(err);
      throw err;
    }
  }

  private async shape(upstream: Response): Promise<Response> {
    const status = upstream.status;
    if (this._bodyMode === "stream") {
      return new Response(upstream.body, {
        status,
        headers: copyResponseHeaders(upstream.headers),
      });
    }
    if (this._bodyMode === "text") {
      const text = await upstream.text();
      return new Response(text, {
        status,
        headers: copyResponseHeaders(upstream.headers),
      });
    }
    const text = await upstream.text();
    const json = text ? JSON.parse(text) : null;
    return this.c.json(json, status as any);
  }

  private upstreamBaseUrl(): string | undefined {
    switch (this._upstream) {
      case "api":
        return this.config.apiBaseUrl;
      case "auth":
        return this.config.authBaseUrl;
      case "obs":
        return this.config.obsBaseUrl;
      case "triage":
        return this.config.triageBaseUrl;
      case "grs":
        return this.config.grsBaseUrl;
      case "mcp":
        return this.config.mcpBaseUrl;
    }
  }
}

export function joinUrl(baseUrl: string, path: string, query?: URLSearchParams): string {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
  if (query && query.toString()) {
    url.search = query.toString();
  }
  return url.toString();
}

const FORWARD_REQUEST_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "cookie",
  "last-event-id",
  "origin",
  "x-request-id",
] as const;

function buildForwardHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const key of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}

const COPY_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "cache-control",
  "connection",
  "content-type",
  "set-cookie",
  "www-authenticate",
]);

function copyResponseHeaders(headers: Headers): Headers {
  const copied = new Headers();
  for (const [key, value] of headers.entries()) {
    if (COPY_RESPONSE_HEADERS.has(key.toLowerCase())) {
      copied.append(key, value);
    }
  }
  return copied;
}

async function readForwardBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  return request.arrayBuffer();
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
