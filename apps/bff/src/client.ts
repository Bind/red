import type { AppRouter as CtlAppRouter } from "@red/ctl";
import { getEnvelope } from "@red/obs";
import type { Context, Hono } from "hono";
import { hc } from "hono/client";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppRouter as AuthAppRouter } from "../../auth/src/server";
import type { AppRouter as ObsAppRouter } from "../../obs/src/service/app";

// Hono's typed generics intentionally use `any` for un-pinned slots; this
// alias is the single quarantined site so the rest of the file stays clean.
// biome-ignore lint/suspicious/noExplicitAny: hono internal generics
type HonoApp = Hono<any, any, any>;

type FetchImpl = (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;

export type Upstream = "api" | "auth" | "obs" | "grs";
export type AuthMode = "jwt" | "cookie" | "session" | "none";
export type BodyMode = "json" | "text" | "stream";

export interface ClientConfig {
  apiBaseUrl: string;
  authBaseUrl: string;
  obsBaseUrl?: string;
  grsBaseUrl?: string;
  bureauSourceRoot?: string;
  disableAuth?: boolean;
}

export interface ClientDeps {
  config: ClientConfig;
  fetchImpl: FetchImpl;
}

export type CtlClient = ReturnType<typeof hc<CtlAppRouter>>;
export type AuthClient = ReturnType<typeof hc<AuthAppRouter>>;
export type ObsClient = ReturnType<typeof hc<ObsAppRouter>>;
/**
 * Per-service client factories. Each carries a typed `hc<UpstreamAppRouter>`
 * client; routes invoke upstream methods via `.send($ => $.x.y.$get(...))`
 * with full path / param / query / body type checking.
 *
 * Auth modes (jwt / session / cookie / none) and body shape (json / text /
 * stream) configure the pre-/post-fetch envelope around hc's call.
 */

export function makeApi(deps: ClientDeps): (c: Context) => RouteBuilder<CtlAppRouter> {
  return (c) =>
    new RouteBuilder<CtlAppRouter>(c, deps.config, deps.fetchImpl, "api", {
      auth: "jwt",
      as: "json",
    });
}

export function makeAuth(deps: ClientDeps): (c: Context) => RouteBuilder<AuthAppRouter> {
  return (c) =>
    new RouteBuilder<AuthAppRouter>(c, deps.config, deps.fetchImpl, "auth", {
      auth: "cookie",
      as: "stream",
    });
}

export function makeObs(deps: ClientDeps): (c: Context) => RouteBuilder<ObsAppRouter> {
  return (c) =>
    new RouteBuilder<ObsAppRouter>(c, deps.config, deps.fetchImpl, "obs", {
      auth: "session",
      as: "json",
    });
}

class RouteBuilder<TAppRouter extends HonoApp> {
  private _auth: AuthMode;
  private _bodyMode: BodyMode;
  private _onError: ((err: unknown) => Response | Promise<Response>) | undefined;

  constructor(
    private c: Context,
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
  async send(
    callback: (client: ReturnType<typeof hc<TAppRouter>>) => Promise<Response>,
  ): Promise<Response> {
    const baseUrl = this.upstreamBaseUrl();
    if (!baseUrl) {
      return this.c.json({ error: `${this.upstream} backend not configured` }, 503);
    }

    const requestId = requestIdFromContext(this.c);
    const forwardHeaders = buildForwardHeaders(this.c.req.raw, requestId);

    if (this._auth === "jwt") {
      const exchanged = await fetchSessionExchangeToken(
        this.c.req.raw,
        this.fetchImpl,
        this.config.authBaseUrl,
        requestId,
      );
      if (exchanged instanceof Response) return exchanged;
      forwardHeaders.set("authorization", `Bearer ${exchanged.accessToken}`);
    } else if (this._auth === "session" && !this.config.disableAuth) {
      const gate = await fetchSessionExchangeToken(
        this.c.req.raw,
        this.fetchImpl,
        this.config.authBaseUrl,
        requestId,
      );
      if (gate instanceof Response) return gate;
    }

    const isCookie = this._auth === "cookie";
    const customFetch: FetchImpl = (input, init) => {
      const merged = new Headers(init?.headers);
      forwardHeaders.forEach((value, key) => {
        merged.set(key, value);
      });
      const finalInit: RequestInit = { ...init, headers: merged };
      if (isCookie) finalInit.redirect = "manual";
      return this.fetchImpl(input, finalInit);
    };

    const client = hc<TAppRouter>(baseUrl, { fetch: customFetch });

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
      case "grs":
        return this.config.grsBaseUrl;
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
  c: Context,
  deps: ClientDeps,
  pathAndSearch: string,
): Promise<Response> {
  const targetUrl = joinUrl(deps.config.authBaseUrl, pathAndSearch);
  const headers = buildForwardHeaders(c.req.raw, requestIdFromContext(c));
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
  if (query?.toString()) {
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

function buildForwardHeaders(request: Request, requestId?: string): Headers {
  const headers = new Headers();
  for (const key of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  if (!headers.has("x-request-id") && requestId) {
    headers.set("x-request-id", requestId);
  }
  return headers;
}

function requestIdFromContext(c: Context): string | undefined {
  try {
    const requestId = getEnvelope(c).requestId;
    return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
  } catch {
    return undefined;
  }
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

function readForwardBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return Promise.resolve(undefined);
  }
  return request.arrayBuffer();
}

async function fetchSessionExchangeToken(
  request: Request,
  fetchImpl: FetchImpl,
  authBaseUrl: string,
  requestId?: string,
): Promise<{ accessToken: string } | Response> {
  const upstream = await fetchImpl(joinUrl(authBaseUrl, "/session/exchange"), {
    method: "POST",
    headers: buildForwardHeaders(request, requestId),
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
