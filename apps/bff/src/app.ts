import { Hono, createHttpLogger } from "@red/server";
import {
  collectHealthReport,
  createObsSinkFromEnv,
  getEnvelope,
  type ObsFields,
  obsMiddleware,
} from "@red/obs";
import {
  createHostedRepoReader,
  splitHostedRepoId,
  type HostedRepoConfig,
  type HostedRepoReader,
} from "./hosted-repo";
import {
  forwardAuthRequest,
  joinUrl,
  makeApi,
  makeAuth,
  makeObs,
  makeTriage,
  type ClientConfig,
} from "./client";

type FetchImpl = (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BffConfig extends ClientConfig {
  port: number;
  fetchImpl?: FetchImpl;
  hostedRepo?: HostedRepoConfig;
  hostedRepoReader?: HostedRepoReader;
}

function resolveHostedRepoConfig(
  configured: HostedRepoConfig | undefined,
  repoId: string | null | undefined,
): HostedRepoConfig | null {
  const requested = repoId?.trim();
  if (requested) {
    return {
      repoId: requested,
      apiBaseUrl: configured?.apiBaseUrl ?? "http://localhost:3000",
      readmePath: configured?.readmePath ?? "README.md",
    };
  }
  return configured ?? null;
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

async function readBestEffortBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readJsonOrNull(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
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
  const startedAt = Date.now();
  const fetchImpl = config.fetchImpl ?? fetch;
  const deps = { config, fetchImpl };
  const api = makeApi(deps);
  const auth = makeAuth(deps);
  const obs = makeObs(deps);
  const triage = makeTriage(deps);

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
          body: { service: "bff", status: "ok" },
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
    .get("/me", (c) => auth(c).send(($) => $.me.$get()))
    .get("/dev/magic-link", (c) =>
      auth(c).send(($) =>
        $.__test__.mailbox.latest.$get({
          query: { email: c.req.query("email") },
        }),
      ),
    )
    .post("/auth/login-attempts", async (c) => {
      const body = await readJsonOrNull(c.req.raw);
      return auth(c).send(($) => $["login-attempts"].$post({ json: body }));
    })
    .get("/auth/login-attempts/:id", (c) =>
      auth(c).send(($) =>
        $["login-attempts"][":id"].$get({ param: { id: c.req.param("id") } }),
      ),
    )
    .post("/auth/login-attempts/redeem", async (c) => {
      const body = await readJsonOrNull(c.req.raw);
      return auth(c).send(($) => $["login-attempts"].redeem.$post({ json: body }));
    })
    .post("/auth/magic-link/complete", async (c) => {
      const body = await readJsonOrNull(c.req.raw);
      return auth(c).send(($) => $["magic-link"].complete.$post({ json: body }));
    })
    .post("/auth/user/two-factor/enroll", (c) =>
      auth(c).send(($) => $.user["two-factor"].enroll.$post({ json: {} })),
    )
    .post("/auth/user/two-factor/verify", async (c) => {
      const body = await readJsonOrNull(c.req.raw);
      return auth(c).send(($) => $.user["two-factor"].verify.$post({ json: body }));
    })
    .post("/auth/user/totp-login", async (c) => {
      const body = await readJsonOrNull(c.req.raw);
      return auth(c).send(($) => $.user["totp-login"].$post({ json: body }));
    })
    .post("/auth/user/onboarding/complete", (c) =>
      auth(c).send(($) => $.user.onboarding.complete.$post({ json: {} })),
    )
    .get("/app/hosted-repo", async (c) => {
      const hostedRepoConfig = resolveHostedRepoConfig(config.hostedRepo, c.req.query("repo"));
      const envelope = getEnvelope(c);
      const hostedRepoReader =
        config.hostedRepoReader
        ?? (hostedRepoConfig ? createHostedRepoReader(hostedRepoConfig, fetchImpl) : null);
      if (!hostedRepoReader) {
        return c.json({ error: "Hosted repo app is not configured" }, 404);
      }
      return c.json(await hostedRepoReader.readSnapshot({ requestId: envelope.requestId }));
    })
    .get("/app/hosted-repo/tree", (c) => {
      const hostedRepoConfig = resolveHostedRepoConfig(config.hostedRepo, c.req.query("repo"));
      if (!hostedRepoConfig) return c.json({ error: "Hosted repo app is not configured" }, 404);
      const { owner, name } = splitHostedRepoId(hostedRepoConfig.repoId);
      return api(c)
        .auth("none")
        .as("stream")
        .send(($) =>
          $.api.repos[":owner"][":repo"].tree.$get({
            param: { owner, repo: name },
            query: { ref: c.req.query("ref") },
          }),
        );
    })
    .get("/app/hosted-repo/file", (c) => {
      const hostedRepoConfig = resolveHostedRepoConfig(config.hostedRepo, c.req.query("repo"));
      if (!hostedRepoConfig) return c.json({ error: "Hosted repo app is not configured" }, 404);
      const path = c.req.query("path");
      if (!path) return c.json({ error: "Missing path query parameter" }, 400);
      const { owner, name } = splitHostedRepoId(hostedRepoConfig.repoId);
      return api(c)
        .auth("none")
        .as("stream")
        .send(($) =>
          $.api.repos[":owner"][":repo"].file.$get({
            param: { owner, repo: name },
            query: { path, ref: c.req.query("ref") },
          }),
        );
    })
    .get("/app/hosted-repo/commits/:sha/diff", (c) => {
      const hostedRepoConfig = resolveHostedRepoConfig(config.hostedRepo, c.req.query("repo"));
      if (!hostedRepoConfig) return c.json({ error: "Hosted repo app is not configured" }, 404);
      const { owner, name } = splitHostedRepoId(hostedRepoConfig.repoId);
      return api(c)
        .auth("none")
        .as("stream")
        .send(($) =>
          $.api.repos[":owner"][":repo"].commits[":sha"].diff.$get({
            param: { owner, repo: name, sha: c.req.param("sha") },
          }),
        );
    })
    .get("/velocity", (c) =>
      api(c).send(($) =>
        $.api.velocity.$get({ query: { hours: c.req.query("hours") } }),
      ),
    )
    .get("/review", (c) => api(c).send(($) => $.api.review.$get()))
    .get("/jobs/pending", (c) => api(c).send(($) => $.api.jobs.pending.$get()))
    .get("/repos", (c) => api(c).send(($) => $.api.repos.$get()))
    .post("/repos", async (c) => {
      const body = await readJsonOrNull(c.req.raw);
      return api(c).send(($) => $.api.repos.$post({ json: body }));
    })
    .get("/branches", (c) =>
      api(c).send(($) =>
        $.api.branches.$get({ query: { repo: c.req.query("repo") } }),
      ),
    )
    .get("/changes/:id", (c) =>
      api(c).send(($) => $.api.changes[":id"].$get({ param: { id: c.req.param("id") } })),
    )
    .get("/changes/:id/diff", (c) =>
      api(c)
        .as("text")
        .send(($) =>
          $.api.changes[":id"].diff.$get({ param: { id: c.req.param("id") } }),
        ),
    )
    .post("/changes/:id/regenerate-summary", (c) =>
      api(c).send(($) =>
        $.api.changes[":id"]["regenerate-summary"].$post({
          param: { id: c.req.param("id") },
        }),
      ),
    )
    .post("/changes/:id/requeue-summary", (c) =>
      api(c).send(($) =>
        $.api.changes[":id"]["requeue-summary"].$post({
          param: { id: c.req.param("id") },
        }),
      ),
    )
    .get("/changes/:id/sessions", (c) =>
      api(c).send(($) =>
        $.api.changes[":id"].sessions.$get({ param: { id: c.req.param("id") } }),
      ),
    )
    .get("/changes/:id/agent-events", (c) =>
      api(c)
        .as("stream")
        .send(($) =>
          $.api.changes[":id"]["agent-events"].$get({ param: { id: c.req.param("id") } }),
        ),
    )
    .get("/sessions/:id/events", (c) =>
      api(c).send(($) =>
        $.api.sessions[":id"].events.$get({
          param: { id: c.req.param("id") },
          query: {
            after: c.req.query("after"),
            limit: c.req.query("limit"),
          },
        }),
      ),
    )
    // ── triage UI data: wide events + triage runs ───────────────────────────
    // These talk to obs + triage as internal services; auth("session") gates
    // access without injecting a Bearer (and is a no-op when disableAuth is set).
    .get("/daemons", (c) => obs(c).send(($) => $.v1.daemons.$get()))
    .get("/daemons/:name/memory", (c) =>
      obs(c).send(($) =>
        $.v1.daemons[":daemon"].memory.$get({
          param: { daemon: c.req.param("name") },
          query: { repo: c.req.query("repo") },
        }),
      ),
    )
    .get("/daemons/:name/runs", (c) =>
      obs(c).send(($) =>
        $.v1.daemons[":daemon"].runs.$get({
          param: { daemon: c.req.param("name") },
          query: { repo: c.req.query("repo") },
        }),
      ),
    )
    .get("/rollups", (c) =>
      obs(c).send(($) =>
        $.v1.rollups.$get({
          query: {
            service: c.req.query("service"),
            outcome: c.req.query("outcome"),
            since: c.req.query("since"),
            limit: c.req.query("limit"),
          },
        }),
      ),
    )
    .get("/rollups/stream", (c) =>
      obs(c)
        .as("stream")
        .send(($) =>
          $.v1.rollups.stream.$get({
            query: {
              service: c.req.query("service"),
              outcome: c.req.query("outcome"),
            },
          }),
        ),
    )
    .get("/rollups/:request_id", (c) =>
      obs(c).send(($) =>
        $.v1.rollups[":request_id"].$get({
          param: { request_id: c.req.param("request_id") },
        }),
      ),
    )
    .get("/logs", (c) =>
      api(c)
        .auth("session")
        .send(($) =>
          $.api.logs.$get({
            query: {
              service: c.req.query("service"),
              level: c.req.query("level"),
              logger: c.req.query("logger"),
              search: c.req.query("search"),
              window: c.req.query("window"),
              limit: c.req.query("limit"),
              status_code: c.req.query("status_code"),
              status_class: c.req.query("status_class"),
            },
          }),
        ),
    )
    .get("/logs/stream", (c) =>
      api(c)
        .auth("session")
        .as("stream")
        .send(($) =>
          $.api.logs.stream.$get({
            query: {
              service: c.req.query("service"),
              level: c.req.query("level"),
              logger: c.req.query("logger"),
              search: c.req.query("search"),
              status_class: c.req.query("status_class"),
              history_window: c.req.query("history_window"),
            },
          }),
        ),
    )
    .get("/triage/runs", (c) =>
      triage(c)
        .onError((err) => {
          console.warn("[bff] triage runs unavailable, returning empty list", err);
          return c.json({ runs: [] });
        })
        .send(($) => $.v1.runs.$get()),
    );

  const app = new Hono()
    .use(
      "*",
      obsMiddleware({ service: "bff", sink: createObsSinkFromEnv({ service: "bff" }) }),
    )
    .use("*", createHttpLogger({ service: "bff", app: "red" }))
    .get("/health", async (c) => {
      const envelope = getEnvelope(c);
      envelope.set({ route: { name: "health" } });
      const report = await collectHealthReport({
        service: "bff",
        startedAtMs: startedAt,
        checks: {
          auth: async () => {
            const response = await fetchImpl(joinUrl(config.authBaseUrl, "/health"), {
              headers: { "x-request-id": envelope.requestId },
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
              headers: { "x-request-id": envelope.requestId },
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
          checks: report.checks as unknown as ObsFields,
        },
      });
      c.header("x-request-id", envelope.requestId);
      return c.json(report, report.status === "ok" ? 200 : 503);
    })
    .all("/api/auth/*", (c) => {
      const incoming = new URL(c.req.url);
      return forwardAuthRequest(c, deps, incoming.pathname + incoming.search);
    })
    .route("/rpc", rpc);

  return app;
}

export type AppRouter = ReturnType<typeof createApp>;
