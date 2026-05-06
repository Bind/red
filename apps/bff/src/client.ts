import { hc } from "hono/client";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppRouter as CtlAppRouter } from "@red/ctl";
import type { AppRouter as AuthAppRouter } from "../../auth/src/server";
import type { AppRouter as ObsAppRouter } from "../../obs/src/service/app";
import type { AppRouter as TriageAppRouter } from "../../triage/src/app";

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

export type CtlClient = ReturnType<typeof hc<CtlAppRouter>>;
export type AuthClient = ReturnType<typeof hc<AuthAppRouter>>;
export type ObsClient = ReturnType<typeof hc<ObsAppRouter>>;
export type TriageClient = ReturnType<typeof hc<TriageAppRouter>>;

/**
 * Per-service client factories. Each carries a typed `hc<UpstreamAppRouter>`
 * client; routes invoke upstream methods via `.send($ => $.x.y.$get(...))`
 * with full path / param / query / body type checking.
 *
 * Auth modes (jwt / session / cookie / none) and body shape (json / text /
 * stream) configure the pre-/post-fetch envelope around hc's call.
 */

export function makeApi(deps: ClientDeps): (c: any) => RouteBuilder<CtlClient> {
  return (c: any) =>
    new RouteBuilder<CtlClient>(c, deps.config, deps.fetchImpl, "api", {
      auth: "jwt",
      as: "json",
    });
}

export function makeAuth(deps: ClientDeps): (c: any) => RouteBuilder<AuthClient> {
  return (c: any) =>
    new RouteBuilder<AuthClient>(c, deps.config, deps.fetchImpl, "auth", {
      auth: "cookie",
      as: "stream",
    });
}

export function makeObs(deps: ClientDeps): (c: any) => RouteBuilder<ObsClient> {
  return (c: any) =>
    new RouteBuilder<ObsClient>(c, deps.config, deps.fetchImpl, "obs", {
      auth: "session",
      as: "json",
    });
}

export function makeTriage(deps: ClientDeps): (c: any) => RouteBuilder<TriageClient> {
  return (c: any) =>
    new RouteBuilder<TriageClient>(c, deps.config, deps.fetchImpl, "triage", {
      auth: "session",
      as: "json",
    });
}

class RouteBuilder<TClient> {
  private _auth: AuthMode;
  private _bodyMode: BodyMode;
  private _onError: ((err: unknown) => Response | Promise<Response>) | undefined;

  constructor(
    private c: any,
    private config: ClientConfig,
    private fetchImpl: FetchImpl,
    private upstream: Upstream,
    defaults: { auth: AuthMode; as: BodyMode },
  ) {
    this._auth = defaults.auth;
    this._bodyMode = defaults.as;
  }

  auth(mode: AuthMode): this {
    this._auth = mode;
    return this;
  }

  as(mode: BodyMode): this {
    this._bodyMode = mode;
    return this;
  }

  onError(fn: (err: unknown) => Response | Promise<Response>): this {
    this._onError = fn;
    return this;
  }

  /**
   * Invoke an upstream endpoint via the typed hc client. The callback
   * receives the per-request hc client (configured with auth + forwarded
   * headers) and returns hc's typed Response.
   *
   *   api(c).send($ => $.api.repos.$get())
   *   api(c).send($ => $.api.changes[":id"].$get({ param: { id } }))
   *   api(c).as("stream").send($ => $.api.changes[":id"]["agent-events"].$get({ param: { id } }))
   */
  async send(callback: (client: TClient) => Promise<Response>): Promise<Response> {
    const baseUrl = this.upstreamBaseUrl();
    if (!baseUrl) {
      return this.c.json({ error: `${this.upstream} backend not configured` }, 503);
    }

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

    const isCookie = this._auth === "cookie";
    const customFetch: FetchImpl = async (input, init) => {
      const merged = new Headers(init?.headers);
      forwardHeaders.forEach((value, key) => merged.set(key, value));
      const finalInit: RequestInit = { ...init, headers: merged };
      if (isCookie) finalInit.redirect = "manual";
      return this.fetchImpl(input, finalInit);
    };

    const client = hc<any>(baseUrl, { fetch: customFetch }) as TClient;

    try {
      const upstream = await callback(client);
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
    return this.c.json(json, status as ContentfulStatusCode);
  }

  private upstreamBaseUrl(): string | undefined {
    switch (this.upstream) {
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

/**
 * Wildcard escape hatch: forwards an opaque path under `authBaseUrl`
 * verbatim (cookies preserved, redirects manual, set-cookie passed back).
 *
 * Used only for the `app.all("/api/auth/*", ...)` mount where better-auth's
 * adapter handles dynamic sub-paths that aren't part of any typed RPC
 * surface. Should disappear once edge routing (Caddy / Envoy) takes over
 * the prefix proxy.
 */
export async function forwardAuthRequest(
  c: any,
  deps: ClientDeps,
  pathAndSearch: string,
): Promise<Response> {
  const targetUrl = joinUrl(deps.config.authBaseUrl, pathAndSearch);
  const headers = buildForwardHeaders(c.req.raw);
  const body = await readForwardBody(c.req.raw);
  const upstream = await deps.fetchImpl(targetUrl, {
    method: c.req.method,
    headers,
    body,
    redirect: "manual",
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyResponseHeaders(upstream.headers),
  });
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
