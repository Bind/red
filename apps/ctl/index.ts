import {
  Hono,
  configureServerLogging,
  createHttpLogger,
  getServerLogger,
} from "@red/server";
import {
  createObsSinkFromEnv,
  getEnvelope,
  obsMiddleware,
  type EventEnvelope,
} from "@red/obs";
import { buildHealth, statusHttpCode } from "@red/health";
import { streamSSE } from "hono/streaming";
import { initDatabase } from "./db/schema";
import {
  ChangeQueries,
  EventQueries,
  JobQueries,
  DeliveryQueries,
  RepoQueries,
  SessionQueries,
} from "./db/queries";
import { GitServerHttpRepositoryProvider } from "./repo/git-server-http-provider";
import type { RepositoryProvider } from "./repo/repository-provider";
import { ScoringEngine } from "./engine/review";
import { StubSummaryGenerator, ClawSummaryGenerator } from "./engine/summary";
import type { SummaryGenerator } from "./engine/summary";
import { EventBus } from "./engine/event-bus";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ChangeStateMachine } from "./engine/state-machine";
import { JobWorker } from "./jobs/worker";
import { NotificationSender } from "./jobs/notify";
import {
  ClawRunReconciler,
  ClawArtifactUploader,
  DockerClawRunner,
  OpenCodeBatchAgentRuntime,
  LocalClawArtifactStore,
  SqliteClawRunTracker,
  MinioClawArtifactStore,
  getRequiredMinioArtifactStoreConfig,
  type AgentRuntimeEvent,
} from "./claw";
import { getClawActionMetadata, getClawActionPrompt, listClawActions } from "./claw/actions";
import { ingestRefUpdate } from "./ingest/ref-updates";
import type { RepoVisibility } from "./types";
import {
  DEFAULT_PLAYGROUND_PROFILES,
  runDaemonPlayground,
  type PlaygroundProfile,
} from "../../bureau/workflows/daemon-review/src/playground";
import { queryLokiLogEvents, queryLokiLogs } from "./logs/loki";
import type { LogQueryInput } from "./logs/loki";

export interface AppConfig {
  port: number;
  dbPath: string;
  repoBackend: {
    kind: "git_storage";
    publicUrl: string;
    defaultOwner: string;
    defaultBranch: string;
    controlPlane: {
      baseUrl: string;
      username?: string;
      password?: string;
    };
  };
  repos: string[];
  artifacts: {
    minio: {
      endPoint: string;
      port: number;
      useSSL: boolean;
      accessKey: string;
      secretKey: string;
      bucket: string;
      prefix?: string;
    };
  };
}

interface RepoCreateInput {
  owner?: string;
  name?: string;
  default_branch?: string;
  visibility?: RepoVisibility;
}

function loadConfig(): AppConfig {
  const configuredRepos = (process.env.RED_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  return {
    port: parseInt(process.env.RED_PORT ?? "3000", 10),
    dbPath: process.env.RED_DB_PATH ?? ".local/state/red.db",
    repoBackend: {
      kind: "git_storage",
      publicUrl: process.env.GIT_STORAGE_PUBLIC_URL ?? "http://grs:8080",
      defaultOwner: process.env.GIT_STORAGE_DEFAULT_OWNER ?? inferDefaultOwner(configuredRepos),
      defaultBranch: process.env.GIT_STORAGE_DEFAULT_BRANCH ?? "main",
      controlPlane: {
        baseUrl: process.env.GIT_STORAGE_CONTROL_PLANE_URL
          ?? process.env.GIT_STORAGE_PUBLIC_URL
          ?? "http://grs:8080",
        username: process.env.GIT_STORAGE_CONTROL_PLANE_USERNAME
          ?? process.env.GIT_SERVER_ADMIN_USERNAME,
        password: process.env.GIT_STORAGE_CONTROL_PLANE_PASSWORD
          ?? process.env.GIT_SERVER_ADMIN_PASSWORD,
      },
    },
    repos: configuredRepos,
    artifacts: {
      minio: getRequiredMinioArtifactStoreConfig(),
    },
  };
}

export function createApp(config: AppConfig) {
  const db = initDatabase(config.dbPath);

  const changes = new ChangeQueries(db);
  const events = new EventQueries(db);
  const jobs = new JobQueries(db);
  const deliveries = new DeliveryQueries(db);
  const repos = new RepoQueries(db);
  const sessions = new SessionQueries(db);
  for (const repoId of config.repos) {
    const [owner, name] = repoId.split("/", 2);
    if (!owner || !name) continue;
    repos.ensure({
      owner,
      name,
      default_branch: config.repoBackend.defaultBranch,
      visibility: "private",
    });
  }
  const repositoryProvider: RepositoryProvider = new GitServerHttpRepositoryProvider({
    baseUrl: config.repoBackend.controlPlane.baseUrl,
    username: config.repoBackend.controlPlane.username,
    password: config.repoBackend.controlPlane.password,
  });
  const stateMachine = new ChangeStateMachine(changes, events);
  const clawTracker = new SqliteClawRunTracker();
  const localClawArtifactStore = new LocalClawArtifactStore();
  const remoteClawArtifactStore = new MinioClawArtifactStore(config.artifacts.minio);
  const logger = getServerLogger(["ctl"]);

  const app = new Hono<{ Variables: { envelope: EventEnvelope } }>();
  app.use("*", obsMiddleware({ service: "api", sink: createObsSinkFromEnv({ service: "api" }) }));
  app.use("*", createHttpLogger({ service: "api", app: "red" }));

  // Health check
  app.get("/health", (c) => {
    getEnvelope(c).set({
      route: {
        name: "health",
      },
    });
    const health = buildHealth({ service: "ctl" });
    return c.json(health, statusHttpCode(health.status));
  });

  // Queue stats endpoint
  app.get("/api/velocity", (c) => {
    const hours = parseInt(c.req.query("hours") ?? "24", 10);
    const velocity = changes.mergeVelocity(hours);
    return c.json(velocity);
  });

  // Change detail endpoint
  app.get("/api/changes/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const change = changes.getById(id);
    if (!change) return c.json({ error: "Not found" }, 404);
    const changeEvents = events.listByChangeId(id);
    return c.json({ ...change, events: changeEvents });
  });

  // Change diff endpoint (raw unified diff)
  app.get("/api/changes/:id/diff", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const change = changes.getById(id);
    if (!change) return c.json({ error: "Not found" }, 404);

    const [owner, repo] = change.repo.split("/");
    const diff = await repositoryProvider.getDiff(owner, repo, change.base_branch, change.head_sha);
    return c.text(diff);
  });

  // List changes for review
  app.get("/api/review", (c) => {
    const list = changes.listForReview();
    return c.json(list);
  });

  // Pending jobs count
  app.get("/api/jobs/pending", (c) => {
    return c.json({ pending: jobs.pendingCount() });
  });

  app.post("/api/daemon-review/playground", async (c) => {
    try {
      const body: { profiles?: PlaygroundProfile[] } =
        await c.req.json<{ profiles?: PlaygroundProfile[] }>().catch(() => ({}));
      const requestedProfiles = Array.isArray(body.profiles) && body.profiles.length > 0
        ? body.profiles
        : DEFAULT_PLAYGROUND_PROFILES;
      const result = await runDaemonPlayground(requestedProfiles);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Playground run failed";
      logger.error`daemon playground failed: ${message}`;
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/logs", async (c) => {
    try {
      const statusCodeRaw = c.req.query("status_code");
      const limitRaw = c.req.query("limit");
      const result = await queryLokiLogs({
        service: c.req.query("service") ?? undefined,
        level: c.req.query("level") ?? undefined,
        logger: c.req.query("logger") === "http" ? "http" : "all",
        search: c.req.query("search") ?? undefined,
        window: c.req.query("window") ?? undefined,
        statusClass: (() => {
          const value = c.req.query("status_class");
          return value === "2xx" || value === "3xx" || value === "4xx" || value === "5xx"
            ? value
            : undefined;
        })(),
        statusCode: statusCodeRaw ? Number.parseInt(statusCodeRaw, 10) : undefined,
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
      });
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Log query failed";
      logger.error`log query failed: ${message}`;
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/logs/stream", (c) => {
    const statusClass: LogQueryInput["statusClass"] = (() => {
      const value = c.req.query("status_class");
      return value === "2xx" || value === "3xx" || value === "4xx" || value === "5xx"
        ? value
        : undefined;
    })();
    const query: LogQueryInput = {
      service: c.req.query("service") ?? undefined,
      level: c.req.query("level") ?? undefined,
      logger: c.req.query("logger") === "http" ? "http" as const : "all" as const,
      search: c.req.query("search") ?? undefined,
      statusClass,
    };
    const historyWindowRaw = c.req.query("history_window");
    const historyWindowMs = (() => {
      const raw = historyWindowRaw?.trim() ?? "15s";
      const match = raw.match(/^(\d+)([smh])$/);
      if (!match) return 15_000;
      const amount = Number.parseInt(match[1], 10);
      const unit = match[2];
      if (unit === "s") return amount * 1000;
      if (unit === "m") return amount * 60_000;
      return amount * 60 * 60_000;
    })();

    return streamSSE(c, async (stream) => {
      let closed = false;
      let cursorNs = `${BigInt(Date.now() - historyWindowMs) * 1000000n}`;
      const seenIds = new Set<string>();
      stream.onAbort(() => {
        closed = true;
      });

      while (!closed) {
        try {
          const events = await queryLokiLogEvents(query, {
            startNs: cursorNs,
            endNs: `${BigInt(Date.now()) * 1000000n}`,
            limit: 5000,
            direction: "FORWARD",
          });
          for (const event of events) {
            if (seenIds.has(event.id)) continue;
            seenIds.add(event.id);
            cursorNs = event.timestampNs;
            await stream.writeSSE({
              event: "log",
              id: event.id,
              data: JSON.stringify(event.entry),
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Log stream failed";
          logger.error`log stream failed: ${message}`;
          await stream.writeSSE({
            event: "stream-error",
            data: JSON.stringify({ error: message }),
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });
  });

  app.post("/api/ingest/ref-update", async (c) => {
    const body = await c.req.json<{
      repo: string;
      branch: string;
      base_branch: string;
      head_sha: string;
      created_by?: "human" | "agent";
      delivery_id?: string;
      metadata?: Record<string, unknown>;
    }>();

    if (!body.repo || !body.branch || !body.base_branch || !body.head_sha) {
      return c.json({ error: "Missing required fields: repo, branch, base_branch, head_sha" }, 400);
    }

    const result = ingestRefUpdate(
      { changes, events, deliveries, jobs },
      {
        repo: body.repo,
        branch: body.branch,
        baseBranch: body.base_branch,
        headSha: body.head_sha,
        createdBy: body.created_by ?? "human",
        deliveryId: body.delivery_id ?? null,
        metadata: {
          ...(body.metadata ?? {}),
          source: (body.metadata?.source as string | undefined) ?? "local_api",
        },
      }
    );

    if (result.status === "duplicate") {
      return c.json(result, 200);
    }
    if (result.status === "skipped") {
      return c.json(result, 200);
    }
    return c.json(result, 201);
  });

  // Claw action catalog
  app.get("/api/claw/actions", (c) => {
    return c.json(listClawActions());
  });

  app.get("/api/claw/actions/:id", (c) => {
    const action = getClawActionMetadata(c.req.param("id"));
    if (!action) return c.json({ error: "Not found" }, 404);
    return c.json(action);
  });

  app.get("/api/claw/actions/:id/prompt", (c) => {
    const prompt = getClawActionPrompt(c.req.param("id"));
    if (!prompt) return c.json({ error: "Not found" }, 404);
    return c.json(prompt);
  });

  app.get("/api/claw/runs", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    return c.json(clawTracker.listRecent(limit));
  });

  app.get("/api/claw/runs/:runId", (c) => {
    const run = clawTracker.getByRunId(c.req.param("runId"));
    if (!run) return c.json({ error: "Not found" }, 404);
    return c.json(run);
  });

  app.get("/api/claw/runs/:runId/artifacts/:kind", async (c) => {
    const runId = c.req.param("runId");
    const kind = c.req.param("kind");
    if (kind !== "request" && kind !== "result" && kind !== "events") {
      return c.json({ error: "Unknown artifact kind" }, 400);
    }

    const run = clawTracker.getByRunId(runId);
    if (!run) return c.json({ error: "Not found" }, 404);

    const artifactStore = run.rolloutPath?.startsWith("s3://")
      ? remoteClawArtifactStore
      : localClawArtifactStore;
    const text = await artifactStore.readTextArtifact(runId, kind);
    if (text == null) return c.json({ error: "Artifact not found" }, 404);

    const contentType =
      kind === "events" ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8";
    c.header("Content-Type", contentType);
    return c.text(text);
  });

  // Regenerate summary
  app.post("/api/changes/:id/regenerate-summary", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const change = changes.getById(id);
    if (!change) return c.json({ error: "Not found" }, 404);
    if (change.status !== "ready_for_review") {
      return c.json({ error: `Cannot regenerate from status: ${change.status}` }, 400);
    }

    const diffStats = change.diff_stats ? JSON.parse(change.diff_stats as unknown as string) : null;
    if (!diffStats) {
      return c.json({ error: "No diff stats available for this change" }, 400);
    }

    stateMachine.transition(id, "summarizing");
    jobs.enqueue({
      org_id: change.org_id,
      type: "generate_summary",
      payload: JSON.stringify({
        change_id: id,
        diff_stats: diffStats,
      }),
    });

    return c.json({ ok: true });
  });

  // Requeue summary after a failed/dead summary attempt
  app.post("/api/changes/:id/requeue-summary", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const change = changes.getById(id);
    if (!change) return c.json({ error: "Not found" }, 404);
    if (change.status !== "scored") {
      return c.json({ error: `Cannot requeue summary from status: ${change.status}` }, 400);
    }

    const diffStats = change.diff_stats ? JSON.parse(change.diff_stats as unknown as string) : null;
    if (!diffStats) {
      return c.json({ error: "No diff stats available for this change" }, 400);
    }

    stateMachine.transition(id, "summarizing", {
      reason: "manual_requeue_summary",
    });
    jobs.enqueue({
      org_id: change.org_id,
      type: "generate_summary",
      payload: JSON.stringify({
        change_id: id,
        diff_stats: diffStats,
      }),
    });

    return c.json({ ok: true });
  });

  // List known repos (configured via RED_REPOS, then DB, then provider)
  app.get("/api/repos", async (c) => {
    return c.json(repos.list().map((repo) => repo.full_name));
  });

  app.get("/api/repos/:owner/:repo", (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const record = repos.getByFullName(`${owner}/${repo}`);
    if (!record) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(record);
  });

  app.get("/api/repos/:owner/:repo/file", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const path = c.req.query("path");
    const ref = c.req.query("ref") ?? repos.getByFullName(`${owner}/${repo}`)?.default_branch ?? "main";
    const requestId = getEnvelope(c).requestId;

    if (!path) {
      return c.json({ error: "Missing required query param: path" }, 400);
    }

    const record = repos.getByFullName(`${owner}/${repo}`);
    if (!record) {
      return c.json({ error: "Not found" }, 404);
    }

    const content = await repositoryProvider.getFileContent(owner, repo, path, ref, requestId);
    return c.json({ path, ref, content });
  });

  app.get("/api/repos/:owner/:repo/tree", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const ref = c.req.query("ref");
    const requestId = getEnvelope(c).requestId;
    const record = repos.getByFullName(`${owner}/${repo}`);
    if (!record) return c.json({ error: "Not found" }, 404);
    if (!(repositoryProvider as any).listTree) return c.json({ error: "Repo provider does not support tree listing" }, 501);
    const files = await (repositoryProvider as any).listTree(owner, repo, ref, requestId);
    return c.json({ files });
  });

  app.get("/api/repos/:owner/:repo/branches", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const requestId = getEnvelope(c).requestId;
    const record = repos.getByFullName(`${owner}/${repo}`);
    if (!record) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!repositoryProvider.listBranches) {
      return c.json({ error: "Repo provider does not support branch listing" }, 501);
    }

    const branches = await repositoryProvider.listBranches(owner, repo, requestId);
    return c.json(
      branches.map((branch) => ({
        name: branch.name,
        commit: branch.commit,
        protected: branch.protected,
      })),
    );
  });

  app.get("/api/repos/:owner/:repo/commits", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const requestId = getEnvelope(c).requestId;
    const record = repos.getByFullName(`${owner}/${repo}`);
    if (!record) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!repositoryProvider.listCommits) {
      return c.json({ error: "Repo provider does not support commit history" }, 501);
    }

    const ref = c.req.query("ref") ?? record.default_branch;
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    const commits = await repositoryProvider.listCommits(owner, repo, ref, limit, requestId);
    return c.json(commits);
  });

  app.get("/api/repos/:owner/:repo/commits/:sha/diff", async (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const requestId = getEnvelope(c).requestId;
    const record = repos.getByFullName(`${owner}/${repo}`);
    if (!record) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!repositoryProvider.getCommitDiff) {
      return c.json({ error: "Repo provider does not support commit diffs" }, 501);
    }

    const diff = await repositoryProvider.getCommitDiff(owner, repo, c.req.param("sha"), requestId);
    return c.text(diff);
  });

  app.post("/api/repos", async (c) => {
    if (config.repoBackend.kind !== "git_storage") {
      return c.json({ error: "Repository creation is not supported for the local git backend" }, 501);
    }

    const body = (await c.req.json().catch(() => null)) as RepoCreateInput | null;
    const owner = body?.owner?.trim() || config.repoBackend.defaultOwner;
    const name = body?.name?.trim();
    if (!name) {
      return c.json({ error: "Missing required field: name" }, 400);
    }
    if (!owner) {
      return c.json({ error: "Missing required field: owner" }, 400);
    }
    if (name.includes("/")) {
      return c.json({ error: "Repository name must not contain '/'" }, 400);
    }

    const defaultBranch = body?.default_branch?.trim() || config.repoBackend.defaultBranch;
    const visibility = body?.visibility ?? "private";
    if (!["private", "internal", "public"].includes(visibility)) {
      return c.json({ error: "Invalid visibility" }, 400);
    }

    const existing = repos.getByFullName(`${owner}/${name}`);
    if (existing) {
      return c.json({ error: "Repository already exists", repo: existing }, 409);
    }

    const created = repos.create({
      owner,
      name,
      default_branch: defaultBranch,
      visibility,
      created_by_subject: null,
    });

    if (repositoryProvider.getRepo) {
      await repositoryProvider.getRepo(owner, name).catch(() => null);
    }
    return c.json(created, 201);
  });

  // List remote branches for a repo
  app.get("/api/branches", async (c) => {
    const repo = c.req.query("repo");
    if (!repo || !repo.includes("/")) {
      return c.json({ error: "Missing or invalid repo query param (owner/repo)" }, 400);
    }
    const [owner, repoName] = repo.split("/");

    if (!repositoryProvider.getRepo || !repositoryProvider.listBranches) {
      return c.json({ error: "Repo provider does not support branch listing" }, 501);
    }

    const [repoInfo, branches] = await Promise.all([
      repositoryProvider.getRepo(owner, repoName),
      repositoryProvider.listBranches(owner, repoName),
    ]);

    const result = branches
      .filter((b) => b.name !== repoInfo.default_branch)
      .map((b) => {
        const activeChange = changes.getActiveByRepoBranch(repo, b.name);
        return {
          name: b.name,
          commit: b.commit,
          change: activeChange
            ? { id: activeChange.id, status: activeChange.status }
            : null,
        };
      });

    return c.json(result);
  });

  const eventBus = new EventBus();

  // List sessions for a change
  app.get("/api/changes/:id/sessions", (c) => {
    const changeId = parseInt(c.req.param("id"), 10);
    const change = changes.getById(changeId);
    if (!change) return c.json({ error: "Not found" }, 404);
    return c.json(sessions.listByChangeId(changeId));
  });

  app.get("/api/sessions/:id/events", (c) => {
    const sessionId = parseInt(c.req.param("id"), 10);
    const session = sessions.getById(sessionId);
    if (!session) return c.json({ error: "Not found" }, 404);
    const afterSeq = parseInt(c.req.query("after") ?? "0", 10);
    const limit = parseInt(c.req.query("limit") ?? "1000", 10);
    return c.json(sessions.getEventsAfter(sessionId, afterSeq, limit));
  });

  app.get("/api/changes/:id/agent-events", (c) => {
    const changeId = parseInt(c.req.param("id"), 10);
    const change = changes.getById(changeId);
    if (!change) return c.json({ error: "Not found" }, 404);

    const session = sessions.getLatestByChangeId(changeId);

    // No session exists — send done immediately
    if (!session) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "done", data: "" });
      });
    }

    if (session.status !== "running") {
      return streamSSE(c, async (stream) => {
        const events = sessions.getEventsAfter(session.id, 0, 100000);
        for (const event of events) {
          await stream.writeSSE({ event: "event", data: JSON.stringify(event) });
        }
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            session_id: session.id,
            status: session.status,
            duration_ms: session.duration_ms,
          }),
        });
      });
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => { closed = true; });

      const persisted = sessions.getEventsAfter(session.id, 0, 100000);
      for (const event of persisted) {
        if (closed) return;
        await stream.writeSSE({ event: "event", data: JSON.stringify(event) });
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          unsub();
          resolve();
        }, 5 * 60 * 1000);

        const unsub = eventBus.subscribe(
          changeId,
          (event) => {
            if (closed) return;
            stream.writeSSE({ event: "event", data: JSON.stringify(event) }).catch(() => {
              closed = true;
            });
          },
          () => {
            clearTimeout(timeout);
            if (!closed) {
              // Re-fetch session for final status
              const final = sessions.getById(session.id);
              stream.writeSSE({
                event: "done",
                data: JSON.stringify({
                  session_id: session.id,
                  status: final?.status ?? "completed",
                  duration_ms: final?.duration_ms ?? null,
                }),
              }).catch(() => {});
            }
            resolve();
          },
        );

        stream.onAbort(() => {
          clearTimeout(timeout);
          unsub();
        });
      });
    });
  });

  app.get("/api/changes/:id/logs", (c) => {
    const changeId = parseInt(c.req.param("id"), 10);
    const change = changes.getById(changeId);
    if (!change) return c.json({ error: "Not found" }, 404);

    const session = sessions.getLatestByChangeId(changeId);
    if (!session) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "done", data: "" });
      });
    }

    return streamSSE(c, async (stream) => {
      const events = sessions.getEventsAfter(session.id, 0, 100000);
      for (const event of events) {
        for (const line of eventToLogLines(event)) {
          await stream.writeSSE({ event: "log", data: line });
        }
      }
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          session_id: session.id,
          status: session.status,
          duration_ms: session.duration_ms,
        }),
      });
    });
  });

  // Engines
  const scorer = new ScoringEngine();
  const openaiKey = process.env.OPENAI_API_KEY ?? null;
  const clawImage =
    process.env.OPENCODE_RUNNER_IMAGE ??
    process.env.CODEX_RUNNER_IMAGE ??
    "red-claw-runner";
  const hasClawAuth = existsSync(join(homedir(), ".local", "share", "opencode", "auth.json"));
  const runner = (openaiKey || hasClawAuth)
      ? new DockerClawRunner({
        image: clawImage,
        gitBaseUrl: config.repoBackend.publicUrl,
        openaiApiKey: openaiKey,
        tracker: clawTracker,
        artifactStore: localClawArtifactStore,
      })
    : null;
  const agentRuntime = runner
    ? new OpenCodeBatchAgentRuntime({
        runner,
        tracker: clawTracker,
      })
    : null;
  const summary: SummaryGenerator = agentRuntime
    ? new ClawSummaryGenerator(agentRuntime)
    : new StubSummaryGenerator();

  // Notifications
  const notifier = new NotificationSender();

  // Job worker
  const worker = new JobWorker({
    changes,
    events,
    jobs,
    repositoryProvider,
    scorer,
    summary,
    stateMachine,
    notifier,
    notificationConfigs: [],
    eventBus,
    sessions,
  }, {
    fetchRemoteAfterMerge: process.env.FETCH_REMOTE_AFTER_MERGE ?? null,
  });

  const clawReconciler = new ClawRunReconciler({
    tracker: clawTracker,
    changes,
    jobs,
    sessions,
    stateMachine,
  });
  const clawArtifactUploader = new ClawArtifactUploader({
    tracker: clawTracker,
    remoteStore: remoteClawArtifactStore,
  });

  return {
    app,
    db,
    changes,
    events,
    jobs,
    deliveries,
    repos,
    repositoryProvider,
    worker,
    runner,
    clawReconciler,
    clawArtifactUploader,
  };
}

function inferDefaultOwner(repos: string[]): string {
  const first = repos[0];
  if (!first || !first.includes("/")) return "red";
  return first.split("/")[0] || "red";
}

function eventToLogLines(event: { kind: string; type: string; text: string | null; delta: string | null }): string[] {
  if (event.kind === "message" && event.text) {
    return event.text.split(/\r?\n/).filter(Boolean);
  }
  if (event.kind === "lifecycle" && event.type === "session.failed" && event.text) {
    return [event.text];
  }
  return [];
}

// Start server when run directly
if (import.meta.main) {
  await configureServerLogging({ app: "red", lowestLevel: "info" });
  const logger = getServerLogger(["ctl"]);
  const config = loadConfig();
  const { app, worker, clawReconciler, clawArtifactUploader } = createApp(config);

  worker.start();
  clawReconciler.start();
  clawArtifactUploader.start();
  logger.info("ctl listening on {url}", { url: `http://0.0.0.0:${config.port}` });
  Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });
}
