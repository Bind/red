import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "hono/bun";
import { initDatabase } from "./db/schema";
import {
  ChangeQueries,
  EventQueries,
  JobQueries,
  DeliveryQueries,
} from "./db/queries";
import { ForgejoClient } from "./forgejo/client";
import { createWebhookRoutes } from "./api/webhooks";
import { ScoringEngine } from "./engine/review";
import { PolicyEngine } from "./engine/policy";
import { StubSummaryGenerator, CodexSummaryGenerator } from "./engine/summary";
import type { SummaryGenerator } from "./engine/summary";
import { RepoTaskRunner } from "./engine/runner";
import { LogBus } from "./engine/log-bus";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ChangeStateMachine } from "./engine/state-machine";
import { JobWorker } from "./jobs/worker";
import { NotificationSender } from "./jobs/notify";

export interface AppConfig {
  port: number;
  dbPath: string;
  forgejo: {
    baseUrl: string;
    token: string;
  };
  webhookSecret: string;
}

function loadConfig(): AppConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return {
    port: parseInt(process.env.REDC_PORT ?? "3000", 10),
    dbPath: process.env.REDC_DB_PATH ?? "redc.db",
    forgejo: {
      baseUrl: required("FORGEJO_URL"),
      token: required("FORGEJO_TOKEN"),
    },
    webhookSecret: required("WEBHOOK_SECRET"),
  };
}

export function createApp(config: AppConfig) {
  const db = initDatabase(config.dbPath);

  const changes = new ChangeQueries(db);
  const events = new EventQueries(db);
  const jobs = new JobQueries(db);
  const deliveries = new DeliveryQueries(db);
  const forgejo = new ForgejoClient(config.forgejo);
  const stateMachine = new ChangeStateMachine(changes, events);

  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Merge velocity endpoint
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

  // Change diff endpoint (raw unified diff from Forgejo)
  app.get("/api/changes/:id/diff", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const change = changes.getById(id);
    if (!change) return c.json({ error: "Not found" }, 404);

    const [owner, repo] = change.repo.split("/");
    const diff = await forgejo.getDiff(owner, repo, change.base_branch, change.head_sha);
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

  // Manual approve + merge
  app.post("/api/changes/:id/approve", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const change = changes.getById(id);
    if (!change) return c.json({ error: "Not found" }, 404);
    if (change.status !== "ready_for_review") {
      return c.json({ error: `Cannot approve from status: ${change.status}` }, 400);
    }

    jobs.enqueue({
      org_id: change.org_id,
      type: "approve_change",
      payload: JSON.stringify({
        change_id: id,
        policy_decision: { action: "auto-approve" },
      }),
    });

    return c.json({ ok: true });
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

  // Retry a failed merge
  app.post("/api/changes/:id/retry-merge", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const change = changes.getById(id);
    if (!change) return c.json({ error: "Not found" }, 404);
    if (change.status !== "merge_failed") {
      return c.json({ error: `Cannot retry from status: ${change.status}` }, 400);
    }

    jobs.enqueue({
      org_id: change.org_id,
      type: "merge_change",
      payload: JSON.stringify({ change_id: id }),
    });

    return c.json({ ok: true });
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
  app.route("/", webhookRoutes);

  // Log streaming
  const logBus = new LogBus();

  // SSE endpoint for streaming Codex logs
  app.get("/api/changes/:id/logs", (c) => {
    const changeId = parseInt(c.req.param("id"), 10);
    const change = changes.getById(changeId);
    if (!change) return c.json({ error: "Not found" }, 404);

    // If change is no longer summarizing and logBus has no data, send done immediately
    if (change.status !== "summarizing") {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "done", data: "" });
      });
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => { closed = true; });

      await new Promise<void>((resolve) => {
        // Safety timeout — if no done signal in 5 minutes, close the stream
        const timeout = setTimeout(() => {
          unsub();
          resolve();
        }, 5 * 60 * 1000);

        const unsub = logBus.subscribe(
          changeId,
          (line) => {
            if (closed) return;
            stream.writeSSE({ event: "log", data: line }).catch(() => {
              closed = true;
            });
          },
          () => {
            clearTimeout(timeout);
            if (!closed) {
              stream.writeSSE({ event: "done", data: "" }).catch(() => {});
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

  // Engines
  const scorer = new ScoringEngine();
  const policy = new PolicyEngine(forgejo);
  const openaiKey = process.env.OPENAI_API_KEY ?? null;
  const codexImage = process.env.CODEX_RUNNER_IMAGE ?? "redc-codex-runner";
  const hasCodexAuth = existsSync(join(homedir(), ".codex", "auth.json"));
  const runner = (openaiKey || hasCodexAuth)
    ? new RepoTaskRunner({
        image: codexImage,
        forgejoBaseUrl: config.forgejo.baseUrl,
        openaiApiKey: openaiKey,
      })
    : null;
  const summary: SummaryGenerator = runner
    ? new CodexSummaryGenerator(runner)
    : new StubSummaryGenerator();

  // Notifications
  const notifier = new NotificationSender();

  // Job worker
  const worker = new JobWorker({
    changes,
    events,
    jobs,
    forgejo,
    scorer,
    policy,
    summary,
    stateMachine,
    notifier,
    notificationConfigs: [], // loaded from policy at runtime
    logBus,
  }, {
    fetchRemoteAfterMerge: process.env.FETCH_REMOTE_AFTER_MERGE ?? null,
  });

  // Serve frontend static files (production)
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("/*", serveStatic({ path: "./web/dist/index.html" }));

  return { app, db, changes, events, jobs, deliveries, forgejo, worker, runner };
}

// Start server when run directly
if (import.meta.main) {
  const config = loadConfig();
  const { app, worker } = createApp(config);

  worker.start();
  console.log(`redc listening on port ${config.port}`);
  Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });
}
