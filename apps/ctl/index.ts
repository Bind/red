import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createObsSinkFromEnv, type EventEnvelope, obsMiddleware } from "@red/obs";
import { configureServerLogging, createHttpLogger, getServerLogger, Hono } from "@red/server";
import { makeApiRouter } from "./api/router";
import {
  ClawArtifactUploader,
  ClawRunReconciler,
  DockerClawRunner,
  getRequiredMinioArtifactStoreConfig,
  LocalClawArtifactStore,
  MinioClawArtifactStore,
  OpenCodeBatchAgentRuntime,
  SqliteClawRunTracker,
} from "./claw";
import {
  ChangeQueries,
  DeliveryQueries,
  EventQueries,
  JobQueries,
  RepoQueries,
  SessionQueries,
} from "./db/queries";
import { initDatabase } from "./db/schema";
import { EventBus } from "./engine/event-bus";
import { ScoringEngine } from "./engine/review";
import { ChangeStateMachine } from "./engine/state-machine";
import type { SummaryGenerator } from "./engine/summary";
import { ClawSummaryGenerator, StubSummaryGenerator } from "./engine/summary";
import { NotificationSender } from "./jobs/notify";
import { JobWorker } from "./jobs/worker";
import { GitServerHttpRepositoryProvider } from "./repo/git-server-http-provider";
import type { RepositoryProvider } from "./repo/repository-provider";

export type { AppRouter } from "./api/router";

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

function loadConfig(): AppConfig {
  const configuredRepos = (process.env.RED_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  return {
    port: Number.parseInt(process.env.RED_PORT ?? "3000", 10),
    dbPath: process.env.RED_DB_PATH ?? ".local/state/red.db",
    repoBackend: {
      kind: "git_storage",
      publicUrl: process.env.GIT_STORAGE_PUBLIC_URL ?? "http://grs:8080",
      defaultOwner: process.env.GIT_STORAGE_DEFAULT_OWNER ?? inferDefaultOwner(configuredRepos),
      defaultBranch: process.env.GIT_STORAGE_DEFAULT_BRANCH ?? "main",
      controlPlane: {
        baseUrl:
          process.env.GIT_STORAGE_CONTROL_PLANE_URL ??
          process.env.GIT_STORAGE_PUBLIC_URL ??
          "http://grs:8080",
        username:
          process.env.GIT_STORAGE_CONTROL_PLANE_USERNAME ?? process.env.GIT_SERVER_ADMIN_USERNAME,
        password:
          process.env.GIT_STORAGE_CONTROL_PLANE_PASSWORD ?? process.env.GIT_SERVER_ADMIN_PASSWORD,
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
  const eventBus = new EventBus();

  const apiRouter = makeApiRouter({
    config,
    changes,
    events,
    jobs,
    deliveries,
    repos,
    sessions,
    repositoryProvider,
    stateMachine,
    eventBus,
    clawTracker,
    localClawArtifactStore,
    remoteClawArtifactStore,
    logger,
  });

  const app = new Hono<{ Variables: { envelope: EventEnvelope } }>()
    .use("*", obsMiddleware({ service: "api", sink: createObsSinkFromEnv({ service: "api" }) }))
    .use("*", createHttpLogger({ service: "api", app: "red" }))
    .route("/", apiRouter);

  const scorer = new ScoringEngine();
  const openaiKey = process.env.OPENAI_API_KEY ?? null;
  const clawImage =
    process.env.OPENCODE_RUNNER_IMAGE ?? process.env.CODEX_RUNNER_IMAGE ?? "red-claw-runner";
  const hasClawAuth = existsSync(join(homedir(), ".local", "share", "opencode", "auth.json"));
  const runner =
    openaiKey || hasClawAuth
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

  const notifier = new NotificationSender();

  const worker = new JobWorker(
    {
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
    },
    {
      fetchRemoteAfterMerge: process.env.FETCH_REMOTE_AFTER_MERGE ?? null,
    },
  );

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
    apiRouter,
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
  if (!first?.includes("/")) return "red";
  return first.split("/")[0] || "red";
}

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
