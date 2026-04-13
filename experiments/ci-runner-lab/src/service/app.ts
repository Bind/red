import { Hono } from "hono";
import type { CreateJobRequest, JobsService, RetryJobRequest, RunnerConfig } from "../util/types";
import { summarizeJob } from "./runner";

function normalizeEnv(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("env must be an object");
  }

  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`env ${key} must be a string`);
    }
    env[key] = entry;
  }
  return env;
}

function parseCreateJobRequest(body: unknown): CreateJobRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }

  const input = body as Record<string, unknown>;
  return {
    repoId: typeof input.repoId === "string" ? input.repoId.trim() : "",
    commitSha: typeof input.commitSha === "string" ? input.commitSha.trim() : "",
    jobName: typeof input.jobName === "string" ? input.jobName.trim() : "",
    env: normalizeEnv(input.env),
    gitCredentialGrant:
      typeof input.gitCredentialGrant === "string" ? input.gitCredentialGrant.trim() : "",
  };
}

function parseRetryJobRequest(body: unknown): RetryJobRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }

  const input = body as Record<string, unknown>;
  return {
    gitCredentialGrant:
      typeof input.gitCredentialGrant === "string" ? input.gitCredentialGrant.trim() : "",
  };
}

export function createApp(config: RunnerConfig, jobs: JobsService) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/status", (c) =>
    c.json({
      service: "ci-runner-lab",
      mode: config.mode,
      queue: jobs.getState(),
      recentJobs: jobs
        .listJobs()
        .slice(0, 20)
        .map((record) => summarizeJob(record)),
    }),
  );

  app.get("/jobs", (c) =>
    c.json({
      jobs: jobs.listJobs().map((record) => summarizeJob(record)),
    }),
  );

  app.get("/jobs/:jobId", (c) => {
    const record = jobs.getJob(c.req.param("jobId"));
    if (!record) {
      return c.json({ error: "job not found" }, 404);
    }

    return c.json({
      job: {
        ...record.job,
        attempts: record.attempts,
      },
    });
  });

  app.post("/jobs", async (c) => {
    try {
      const body = await c.req.json();
      const record = jobs.createJob(parseCreateJobRequest(body));
      void jobs.tickWorker();
      return c.json(
        {
          queued: true,
          job: summarizeJob(record),
        },
        202,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request";
      return c.json({ error: message }, 400);
    }
  });

  app.post("/jobs/:jobId/retry", async (c) => {
    try {
      const body = await c.req.json();
      const record = jobs.retryJob(c.req.param("jobId"), parseRetryJobRequest(body));
      void jobs.tickWorker();
      return c.json(
        {
          queued: true,
          job: summarizeJob(record),
        },
        202,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request";
      const status = message === "job not found" ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.get("/jobs/:jobId/attempts/:attemptNumber/logs", (c) => {
    const attemptNumber = Number.parseInt(c.req.param("attemptNumber"), 10);
    const afterSequence = Number.parseInt(c.req.query("after_seq") ?? "0", 10);
    if (!Number.isFinite(attemptNumber) || attemptNumber <= 0) {
      return c.json({ error: "attemptNumber must be a positive integer" }, 400);
    }
    if (!Number.isFinite(afterSequence) || afterSequence < 0) {
      return c.json({ error: "after_seq must be a non-negative integer" }, 400);
    }

    return c.json({
      chunks: jobs.getAttemptLogChunks(c.req.param("jobId"), attemptNumber, afterSequence),
    });
  });

  return app;
}
