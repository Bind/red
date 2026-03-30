import { Hono } from "hono";
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
import { StubSummaryGenerator } from "./engine/summary";
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

  // List changes for review
  app.get("/api/review", (c) => {
    const list = changes.listForReview();
    return c.json(list);
  });

  // Pending jobs count
  app.get("/api/jobs/pending", (c) => {
    return c.json({ pending: jobs.pendingCount() });
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

  // Engines
  const scorer = new ScoringEngine();
  const policy = new PolicyEngine(forgejo);
  const summary = new StubSummaryGenerator();
  const stateMachine = new ChangeStateMachine(changes, events);

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
  });

  // Serve frontend static files (production)
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("/*", serveStatic({ path: "./web/dist/index.html" }));

  return { app, db, changes, events, jobs, deliveries, forgejo, worker };
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
