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
import { joinUrl, makeApi, makeAuth, makeObs, makeTriage, type ClientConfig } from "./client";

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
  const api = makeApi({ config, fetchImpl });
  const auth = makeAuth({ config, fetchImpl });
  const obs = makeObs({ config, fetchImpl });
  const triage = makeTriage({ config, fetchImpl });

  const rpc = new Hono()
    .get("/status", async (c) => {
      const envelope = getEnvelope(c as any);
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
    .get("/me", (c) => auth(c).path("/me").send())
    .get("/dev/magic-link", (c) =>
      auth(c).path("/__test__/mailbox/latest").query(["email"]).send(),
    )
    .post("/auth/login-attempts", (c) => auth(c).path("/login-attempts").send())
    .get("/auth/login-attempts/:id", (c) =>
      auth(c).path(`/login-attempts/${c.req.param("id")}`).send(),
    )
    .post("/auth/login-attempts/redeem", (c) =>
      auth(c).path("/login-attempts/redeem").send(),
    )
    .post("/auth/magic-link/complete", (c) =>
      auth(c).path("/magic-link/complete").send(),
    )
    .post("/auth/user/two-factor/enroll", (c) =>
      auth(c).path("/user/two-factor/enroll").send(),
    )
    .post("/auth/user/two-factor/verify", (c) =>
      auth(c).path("/user/two-factor/verify").send(),
    )
    .post("/auth/user/totp-login", (c) => auth(c).path("/user/totp-login").send())
    .post("/auth/user/onboarding/complete", (c) =>
      auth(c).path("/user/onboarding/complete").send(),
    )
    .get("/app/hosted-repo", async (c) => {
      const hostedRepoConfig = resolveHostedRepoConfig(config.hostedRepo, c.req.query("repo"));
      const envelope = getEnvelope(c as any);
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
        .from(($) =>
          $.api.repos[":owner"][":repo"].tree.$url({ param: { owner, repo: name } }),
        )
        .query(["ref"])
        .send();
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
        .from(($) =>
          $.api.repos[":owner"][":repo"].file.$url({ param: { owner, repo: name } }),
        )
        .query(["path", "ref"])
        .send();
    })
    .get("/app/hosted-repo/commits/:sha/diff", (c) => {
      const hostedRepoConfig = resolveHostedRepoConfig(config.hostedRepo, c.req.query("repo"));
      if (!hostedRepoConfig) return c.json({ error: "Hosted repo app is not configured" }, 404);
      const { owner, name } = splitHostedRepoId(hostedRepoConfig.repoId);
      return api(c)
        .auth("none")
        .as("stream")
        .from(($) =>
          $.api.repos[":owner"][":repo"].commits[":sha"].diff.$url({
            param: { owner, repo: name, sha: c.req.param("sha") },
          }),
        )
        .send();
    })
    .get("/velocity", (c) =>
      api(c).from(($) => $.api.velocity.$url()).query(["hours"]).send(),
    )
    .get("/review", (c) => api(c).from(($) => $.api.review.$url()).send())
    .get("/jobs/pending", (c) =>
      api(c).from(($) => $.api.jobs.pending.$url()).send(),
    )
    .get("/repos", (c) => api(c).from(($) => $.api.repos.$url()).send())
    .post("/repos", (c) => api(c).from(($) => $.api.repos.$url()).send())
    .get("/branches", (c) =>
      api(c).from(($) => $.api.branches.$url()).query(["repo"]).send(),
    )
    .get("/changes/:id", (c) =>
      api(c)
        .from(($) => $.api.changes[":id"].$url({ param: { id: c.req.param("id") } }))
        .send(),
    )
    .get("/changes/:id/diff", (c) =>
      api(c)
        .from(($) =>
          $.api.changes[":id"].diff.$url({ param: { id: c.req.param("id") } }),
        )
        .as("text")
        .send(),
    )
    .post("/changes/:id/regenerate-summary", (c) =>
      api(c)
        .from(($) =>
          $.api.changes[":id"]["regenerate-summary"].$url({
            param: { id: c.req.param("id") },
          }),
        )
        .send(),
    )
    .post("/changes/:id/requeue-summary", (c) =>
      api(c)
        .from(($) =>
          $.api.changes[":id"]["requeue-summary"].$url({
            param: { id: c.req.param("id") },
          }),
        )
        .send(),
    )
    .get("/changes/:id/sessions", (c) =>
      api(c)
        .from(($) =>
          $.api.changes[":id"].sessions.$url({ param: { id: c.req.param("id") } }),
        )
        .send(),
    )
    .get("/changes/:id/agent-events", (c) =>
      api(c)
        .from(($) =>
          $.api.changes[":id"]["agent-events"].$url({
            param: { id: c.req.param("id") },
          }),
        )
        .as("stream")
        .send(),
    )
    .get("/sessions/:id/events", (c) =>
      api(c)
        .from(($) =>
          $.api.sessions[":id"].events.$url({ param: { id: c.req.param("id") } }),
        )
        .query(["after", "limit"])
        .send(),
    )
    // ── triage UI data: wide events + triage runs ───────────────────────────
    // These talk to obs + triage as internal services; auth("session") gates
    // access without injecting a Bearer (and is a no-op when disableAuth is set).
    .get("/daemons", (c) => obs(c).path("/v1/daemons").send())
    .get("/daemons/:name/memory", (c) => {
      const name = encodeURIComponent(c.req.param("name"));
      return obs(c).path(`/v1/daemons/${name}/memory`).query(["repo"]).send();
    })
    .get("/daemons/:name/runs", (c) => {
      const name = encodeURIComponent(c.req.param("name"));
      return obs(c).path(`/v1/daemons/${name}/runs`).query(["repo"]).send();
    })
    .get("/rollups", (c) =>
      obs(c).path("/v1/rollups").query(["service", "outcome", "since", "limit"]).send(),
    )
    .get("/rollups/stream", (c) =>
      obs(c).as("stream").path("/v1/rollups/stream").query(["service", "outcome"]).send(),
    )
    .get("/rollups/:request_id", (c) => {
      const id = encodeURIComponent(c.req.param("request_id"));
      return obs(c).path(`/v1/rollups/${id}`).send();
    })
    .get("/logs", (c) =>
      api(c)
        .auth("session")
        .from(($) => $.api.logs.$url())
        .query([
          "service",
          "level",
          "logger",
          "search",
          "window",
          "limit",
          "status_code",
          "status_class",
        ])
        .send(),
    )
    .get("/logs/stream", (c) =>
      api(c)
        .auth("session")
        .as("stream")
        .from(($) => $.api.logs.stream.$url())
        .query(["service", "level", "logger", "search", "status_class", "history_window"])
        .send(),
    )
    .get("/triage/runs", (c) =>
      triage(c)
        .path("/v1/runs")
        .onError((err) => {
          console.warn("[bff] triage runs unavailable, returning empty list", err);
          return c.json({ runs: [] });
        })
        .send(),
    );

  const app = new Hono()
    .use(
      "*",
      obsMiddleware({ service: "bff", sink: createObsSinkFromEnv({ service: "bff" }) }) as any,
    )
    .use("*", createHttpLogger({ service: "bff", app: "red" }))
    .get("/health", async (c) => {
      const envelope = getEnvelope(c as any);
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
      return auth(c).path(incoming.pathname + incoming.search).send();
    })
    .route("/rpc", rpc);

  return app;
}

export type AppRouter = ReturnType<typeof createApp>;
