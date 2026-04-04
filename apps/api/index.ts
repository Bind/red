import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun";
import { initDatabase } from "./db/schema";
import {
  ChangeQueries,
  EventQueries,
  JobQueries,
  DeliveryQueries,
  SessionQueries,
} from "./db/queries";
import { ForgejoClient } from "./forgejo/client";
import { ForgejoRepositoryProvider } from "./repo/forgejo-provider";
import { GitStorageRepositoryProvider } from "./repo/git-storage-provider";
import { LocalGitProvider } from "./repo/local-git-provider";
import type { RepositoryProvider } from "./repo/repository-provider";
import { createWebhookRoutes } from "./api/webhooks";
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
import { GitSdk } from "../git-server/src/core/git-sdk";

export interface AppConfig {
  port: number;
  dbPath: string;
  repoBackend:
    | {
        kind: "forgejo";
        forgejo: {
          baseUrl: string;
          token: string;
        };
      }
    | {
        kind: "local_git";
        reposRoot: string;
      }
    | {
        kind: "git_storage";
        publicUrl: string;
        defaultOwner: string;
        defaultBranch: string;
        authTokenSecret?: string;
      };
  webhookSecret: string;
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

function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const configuredRepos = (process.env.REDC_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  return {
    port: parseInt(process.env.REDC_PORT ?? "3000", 10),
    dbPath: process.env.REDC_DB_PATH ?? ".local/state/redc.db",
    repoBackend: process.env.REPO_PROVIDER === "local_git"
      ? {
          kind: "local_git",
          reposRoot: required("LOCAL_GIT_REPOS_ROOT"),
        }
      : process.env.REPO_PROVIDER === "git_storage"
        ? {
            kind: "git_storage",
            publicUrl: required("GIT_STORAGE_PUBLIC_URL"),
            defaultOwner: process.env.GIT_STORAGE_DEFAULT_OWNER ?? inferDefaultOwner(configuredRepos),
            defaultBranch: process.env.GIT_STORAGE_DEFAULT_BRANCH ?? "main",
            authTokenSecret: process.env.GIT_STORAGE_AUTH_TOKEN_SECRET,
          }
        : {
            kind: "forgejo",
            forgejo: {
              baseUrl: required("FORGEJO_URL"),
              token: required("FORGEJO_TOKEN"),
            },
          },
    webhookSecret: required("WEBHOOK_SECRET"),
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
  const sessions = new SessionQueries(db);
  const forgejo = config.repoBackend.kind === "forgejo"
    ? new ForgejoClient(config.repoBackend.forgejo)
    : null;
  const forgejoProvider = forgejo ? new ForgejoRepositoryProvider(forgejo) : null;
  const repositoryProvider: RepositoryProvider =
    config.repoBackend.kind === "forgejo"
      ? forgejoProvider!
      : config.repoBackend.kind === "local_git"
        ? new LocalGitProvider({ reposRoot: config.repoBackend.reposRoot })
        : new GitStorageRepositoryProvider({
            storage: new GitSdk({
              publicUrl: config.repoBackend.publicUrl,
              defaultOwner: config.repoBackend.defaultOwner,
              authTokenSecret: config.repoBackend.authTokenSecret,
            }),
            knownRepos: config.repos,
            defaultBranch: config.repoBackend.defaultBranch,
          });
  const stateMachine = new ChangeStateMachine(changes, events);
  const clawTracker = new SqliteClawRunTracker();
  const localClawArtifactStore = new LocalClawArtifactStore();
  const remoteClawArtifactStore = new MinioClawArtifactStore(config.artifacts.minio);

  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

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

  // List known repos (configured via REDC_REPOS, then DB, then Forgejo)
  app.get("/api/repos", async (c) => {
    if (config.repos.length > 0) {
      return c.json(config.repos);
    }
    const dbRepos = changes.listRepos();
    if (dbRepos.length > 0) {
      return c.json(dbRepos);
    }
    const knownRepos = await repositoryProvider.listRepos?.();
    if (!knownRepos) {
      return c.json([]);
    }
    return c.json(knownRepos.map((r) => r.full_name));
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

  // Mount webhook routes
  const webhookRoutes = createWebhookRoutes({
    changes,
    events,
    deliveries,
    jobs,
    forgejo,
    webhookSecret: config.webhookSecret,
  });
  if (forgejo) {
    app.route("/", webhookRoutes);
  }

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
    process.env.CLAW_RUNNER_IMAGE ??
    process.env.CODEX_RUNNER_IMAGE ??
    "redc-claw-runner";
  const hasClawAuth = existsSync(join(homedir(), ".local", "share", "opencode", "auth.json"));
  const runner = (openaiKey || hasClawAuth)
    ? new DockerClawRunner({
        image: clawImage,
        forgejoBaseUrl: config.repoBackend.kind === "forgejo"
          ? config.repoBackend.forgejo.baseUrl
          : "http://localhost",
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

  // Serve frontend static files (production)
  app.use("/*", serveStatic({ root: "./apps/web/dist" }));
  app.get("/*", serveStatic({ path: "./apps/web/dist/index.html" }));

  return {
    app,
    db,
    changes,
    events,
    jobs,
    deliveries,
    forgejo,
    repositoryProvider,
    worker,
    runner,
    clawReconciler,
    clawArtifactUploader,
  };
}

function inferDefaultOwner(repos: string[]): string {
  const first = repos[0];
  if (!first || !first.includes("/")) return "redc";
  return first.split("/")[0] || "redc";
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
  const config = loadConfig();
  const { app, worker, clawReconciler, clawArtifactUploader } = createApp(config);

  worker.start();
  clawReconciler.start();
  clawArtifactUploader.start();
  console.log(`redc listening on port ${config.port}`);
  Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });
}
