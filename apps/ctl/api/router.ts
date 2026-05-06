import { Hono } from "@red/server";
import {
  getEnvelope,
  type EventEnvelope,
} from "@red/obs";
import { buildHealth, statusHttpCode } from "@red/health";
import { streamSSE } from "hono/streaming";
import type {
  ChangeQueries,
  EventQueries,
  JobQueries,
  DeliveryQueries,
  RepoQueries,
  SessionQueries,
} from "../db/queries";
import type { RepositoryProvider } from "../repo/repository-provider";
import type { ChangeStateMachine } from "../engine/state-machine";
import type { EventBus } from "../engine/event-bus";
import type {
  SqliteClawRunTracker,
  LocalClawArtifactStore,
  MinioClawArtifactStore,
} from "../claw";
import {
  getClawActionMetadata,
  getClawActionPrompt,
  listClawActions,
} from "../claw/actions";
import { ingestRefUpdate } from "../ingest/ref-updates";
import type { RepoVisibility } from "../types";
import {
  DEFAULT_PLAYGROUND_PROFILES,
  runDaemonPlayground,
  type PlaygroundProfile,
} from "../../../bureau/workflows/daemon-review/src/playground";
import { queryLokiLogEvents, queryLokiLogs } from "../logs/loki";
import type { LogQueryInput } from "../logs/loki";
import type { AppConfig } from "../index";

export interface ApiDeps {
  config: AppConfig;
  changes: ChangeQueries;
  events: EventQueries;
  jobs: JobQueries;
  deliveries: DeliveryQueries;
  repos: RepoQueries;
  sessions: SessionQueries;
  repositoryProvider: RepositoryProvider;
  stateMachine: ChangeStateMachine;
  eventBus: EventBus;
  clawTracker: SqliteClawRunTracker;
  localClawArtifactStore: LocalClawArtifactStore;
  remoteClawArtifactStore: MinioClawArtifactStore;
  logger: {
    error: (strings: TemplateStringsArray, ...values: unknown[]) => void;
  };
}

interface RepoCreateInput {
  owner?: string;
  name?: string;
  default_branch?: string;
  visibility?: RepoVisibility;
}

function eventToLogLines(event: {
  kind: string;
  type: string;
  text: string | null;
  delta: string | null;
}): string[] {
  if (event.kind === "message" && event.text) {
    return event.text.split(/\r?\n/).filter(Boolean);
  }
  if (event.kind === "lifecycle" && event.type === "session.failed" && event.text) {
    return [event.text];
  }
  return [];
}

export function makeApiRouter(deps: ApiDeps) {
  const {
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
  } = deps;

  return new Hono<{ Variables: { envelope: EventEnvelope } }>()
    .get("/health", (c) => {
      getEnvelope(c).set({ route: { name: "health" } });
      const health = buildHealth({ service: "ctl" });
      return c.json(health, statusHttpCode(health.status));
    })
    .get("/api/velocity", (c) => {
      const hours = parseInt(c.req.query("hours") ?? "24", 10);
      const velocity = changes.mergeVelocity(hours);
      return c.json(velocity);
    })
    .get("/api/changes/:id", (c) => {
      const id = parseInt(c.req.param("id"), 10);
      const change = changes.getById(id);
      if (!change) return c.json({ error: "Not found" }, 404);
      const changeEvents = events.listByChangeId(id);
      return c.json({ ...change, events: changeEvents });
    })
    .get("/api/changes/:id/diff", async (c) => {
      const id = parseInt(c.req.param("id"), 10);
      const change = changes.getById(id);
      if (!change) return c.json({ error: "Not found" }, 404);
      const [owner, repo] = change.repo.split("/");
      const diff = await repositoryProvider.getDiff(
        owner,
        repo,
        change.base_branch,
        change.head_sha,
      );
      return c.text(diff);
    })
    .get("/api/review", (c) => {
      const list = changes.listForReview();
      return c.json(list);
    })
    .get("/api/jobs/pending", (c) => {
      return c.json({ pending: jobs.pendingCount() });
    })
    .post("/api/daemon-review/playground", async (c) => {
      try {
        const body: { profiles?: PlaygroundProfile[] } = await c.req
          .json<{ profiles?: PlaygroundProfile[] }>()
          .catch(() => ({}));
        const requestedProfiles =
          Array.isArray(body.profiles) && body.profiles.length > 0
            ? body.profiles
            : DEFAULT_PLAYGROUND_PROFILES;
        const result = await runDaemonPlayground(requestedProfiles);
        return c.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Playground run failed";
        logger.error`daemon playground failed: ${message}`;
        return c.json({ error: message }, 500);
      }
    })
    .get("/api/logs", async (c) => {
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
    })
    .get("/api/logs/stream", (c) => {
      const statusClass: LogQueryInput["statusClass"] = (() => {
        const value = c.req.query("status_class");
        return value === "2xx" || value === "3xx" || value === "4xx" || value === "5xx"
          ? value
          : undefined;
      })();
      const query: LogQueryInput = {
        service: c.req.query("service") ?? undefined,
        level: c.req.query("level") ?? undefined,
        logger: c.req.query("logger") === "http" ? ("http" as const) : ("all" as const),
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
    })
    .post("/api/ingest/ref-update", async (c) => {
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
        return c.json(
          { error: "Missing required fields: repo, branch, base_branch, head_sha" },
          400,
        );
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
        },
      );

      if (result.status === "duplicate") return c.json(result, 200);
      if (result.status === "skipped") return c.json(result, 200);
      return c.json(result, 201);
    })
    .get("/api/claw/actions", (c) => {
      return c.json(listClawActions());
    })
    .get("/api/claw/actions/:id", (c) => {
      const action = getClawActionMetadata(c.req.param("id"));
      if (!action) return c.json({ error: "Not found" }, 404);
      return c.json(action);
    })
    .get("/api/claw/actions/:id/prompt", (c) => {
      const prompt = getClawActionPrompt(c.req.param("id"));
      if (!prompt) return c.json({ error: "Not found" }, 404);
      return c.json(prompt);
    })
    .get("/api/claw/runs", (c) => {
      const limit = parseInt(c.req.query("limit") ?? "20", 10);
      return c.json(clawTracker.listRecent(limit));
    })
    .get("/api/claw/runs/:runId", (c) => {
      const run = clawTracker.getByRunId(c.req.param("runId"));
      if (!run) return c.json({ error: "Not found" }, 404);
      return c.json(run);
    })
    .get("/api/claw/runs/:runId/artifacts/:kind", async (c) => {
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
        kind === "events"
          ? "application/x-ndjson; charset=utf-8"
          : "application/json; charset=utf-8";
      c.header("Content-Type", contentType);
      return c.text(text);
    })
    .post("/api/changes/:id/regenerate-summary", async (c) => {
      const id = parseInt(c.req.param("id"), 10);
      const change = changes.getById(id);
      if (!change) return c.json({ error: "Not found" }, 404);
      if (change.status !== "ready_for_review") {
        return c.json({ error: `Cannot regenerate from status: ${change.status}` }, 400);
      }

      const diffStats = change.diff_stats
        ? JSON.parse(change.diff_stats as unknown as string)
        : null;
      if (!diffStats) {
        return c.json({ error: "No diff stats available for this change" }, 400);
      }

      stateMachine.transition(id, "summarizing");
      jobs.enqueue({
        org_id: change.org_id,
        type: "generate_summary",
        payload: JSON.stringify({ change_id: id, diff_stats: diffStats }),
      });

      return c.json({ ok: true });
    })
    .post("/api/changes/:id/requeue-summary", async (c) => {
      const id = parseInt(c.req.param("id"), 10);
      const change = changes.getById(id);
      if (!change) return c.json({ error: "Not found" }, 404);
      if (change.status !== "scored") {
        return c.json(
          { error: `Cannot requeue summary from status: ${change.status}` },
          400,
        );
      }

      const diffStats = change.diff_stats
        ? JSON.parse(change.diff_stats as unknown as string)
        : null;
      if (!diffStats) {
        return c.json({ error: "No diff stats available for this change" }, 400);
      }

      stateMachine.transition(id, "summarizing", { reason: "manual_requeue_summary" });
      jobs.enqueue({
        org_id: change.org_id,
        type: "generate_summary",
        payload: JSON.stringify({ change_id: id, diff_stats: diffStats }),
      });

      return c.json({ ok: true });
    })
    .get("/api/repos", async (c) => {
      return c.json(repos.list().map((repo) => repo.full_name));
    })
    .get("/api/repos/:owner/:repo", (c) => {
      const owner = c.req.param("owner");
      const repo = c.req.param("repo");
      const record = repos.getByFullName(`${owner}/${repo}`);
      if (!record) return c.json({ error: "Not found" }, 404);
      return c.json(record);
    })
    .get("/api/repos/:owner/:repo/file", async (c) => {
      const owner = c.req.param("owner");
      const repo = c.req.param("repo");
      const path = c.req.query("path");
      const ref =
        c.req.query("ref") ??
        repos.getByFullName(`${owner}/${repo}`)?.default_branch ??
        "main";
      const requestId = getEnvelope(c).requestId;

      if (!path) return c.json({ error: "Missing required query param: path" }, 400);

      const record = repos.getByFullName(`${owner}/${repo}`);
      if (!record) return c.json({ error: "Not found" }, 404);

      const content = await repositoryProvider.getFileContent(
        owner,
        repo,
        path,
        ref,
        requestId,
      );
      return c.json({ path, ref, content });
    })
    .get("/api/repos/:owner/:repo/tree", async (c) => {
      const owner = c.req.param("owner");
      const repo = c.req.param("repo");
      const ref = c.req.query("ref");
      const requestId = getEnvelope(c).requestId;
      const record = repos.getByFullName(`${owner}/${repo}`);
      if (!record) return c.json({ error: "Not found" }, 404);
      if (!(repositoryProvider as any).listTree) {
        return c.json({ error: "Repo provider does not support tree listing" }, 501);
      }
      const files = await (repositoryProvider as any).listTree(owner, repo, ref, requestId);
      return c.json({ files });
    })
    .get("/api/repos/:owner/:repo/branches", async (c) => {
      const owner = c.req.param("owner");
      const repo = c.req.param("repo");
      const requestId = getEnvelope(c).requestId;
      const record = repos.getByFullName(`${owner}/${repo}`);
      if (!record) return c.json({ error: "Not found" }, 404);
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
    })
    .get("/api/repos/:owner/:repo/commits", async (c) => {
      const owner = c.req.param("owner");
      const repo = c.req.param("repo");
      const requestId = getEnvelope(c).requestId;
      const record = repos.getByFullName(`${owner}/${repo}`);
      if (!record) return c.json({ error: "Not found" }, 404);
      if (!repositoryProvider.listCommits) {
        return c.json({ error: "Repo provider does not support commit history" }, 501);
      }

      const ref = c.req.query("ref") ?? record.default_branch;
      const limit = parseInt(c.req.query("limit") ?? "20", 10);
      const commits = await repositoryProvider.listCommits(owner, repo, ref, limit, requestId);
      return c.json(commits);
    })
    .get("/api/repos/:owner/:repo/commits/:sha/diff", async (c) => {
      const owner = c.req.param("owner");
      const repo = c.req.param("repo");
      const requestId = getEnvelope(c).requestId;
      const record = repos.getByFullName(`${owner}/${repo}`);
      if (!record) return c.json({ error: "Not found" }, 404);
      if (!repositoryProvider.getCommitDiff) {
        return c.json({ error: "Repo provider does not support commit diffs" }, 501);
      }

      const diff = await repositoryProvider.getCommitDiff(
        owner,
        repo,
        c.req.param("sha"),
        requestId,
      );
      return c.text(diff);
    })
    .post("/api/repos", async (c) => {
      if (config.repoBackend.kind !== "git_storage") {
        return c.json(
          { error: "Repository creation is not supported for the local git backend" },
          501,
        );
      }

      const body = (await c.req.json().catch(() => null)) as RepoCreateInput | null;
      const owner = body?.owner?.trim() || config.repoBackend.defaultOwner;
      const name = body?.name?.trim();
      if (!name) return c.json({ error: "Missing required field: name" }, 400);
      if (!owner) return c.json({ error: "Missing required field: owner" }, 400);
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
    })
    .get("/api/branches", async (c) => {
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
            change: activeChange ? { id: activeChange.id, status: activeChange.status } : null,
          };
        });

      return c.json(result);
    })
    .get("/api/changes/:id/sessions", (c) => {
      const changeId = parseInt(c.req.param("id"), 10);
      const change = changes.getById(changeId);
      if (!change) return c.json({ error: "Not found" }, 404);
      return c.json(sessions.listByChangeId(changeId));
    })
    .get("/api/sessions/:id/events", (c) => {
      const sessionId = parseInt(c.req.param("id"), 10);
      const session = sessions.getById(sessionId);
      if (!session) return c.json({ error: "Not found" }, 404);
      const afterSeq = parseInt(c.req.query("after") ?? "0", 10);
      const limit = parseInt(c.req.query("limit") ?? "1000", 10);
      return c.json(sessions.getEventsAfter(sessionId, afterSeq, limit));
    })
    .get("/api/changes/:id/agent-events", (c) => {
      const changeId = parseInt(c.req.param("id"), 10);
      const change = changes.getById(changeId);
      if (!change) return c.json({ error: "Not found" }, 404);

      const session = sessions.getLatestByChangeId(changeId);

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
        stream.onAbort(() => {
          closed = true;
        });

        const persisted = sessions.getEventsAfter(session.id, 0, 100000);
        for (const event of persisted) {
          if (closed) return;
          await stream.writeSSE({ event: "event", data: JSON.stringify(event) });
        }

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(
            () => {
              unsub();
              resolve();
            },
            5 * 60 * 1000,
          );

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
                const final = sessions.getById(session.id);
                stream
                  .writeSSE({
                    event: "done",
                    data: JSON.stringify({
                      session_id: session.id,
                      status: final?.status ?? "completed",
                      duration_ms: final?.duration_ms ?? null,
                    }),
                  })
                  .catch(() => {});
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
    })
    .get("/api/changes/:id/logs", (c) => {
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
}

export type AppRouter = ReturnType<typeof makeApiRouter>;
