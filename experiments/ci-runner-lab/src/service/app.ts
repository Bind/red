import { Hono } from "hono";
import type { RunnerConfig, RunnerService, RunRequest, RunStepInput } from "../util/types";

function normalizeSteps(value: unknown): RunStepInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("steps must be a non-empty array");
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`step ${index + 1} must be an object`);
    }

    const step = entry as Record<string, unknown>;
    const command = typeof step.run === "string" ? step.run.trim() : "";
    const name = typeof step.name === "string" && step.name.trim() ? step.name.trim() : "";
    if (!command) {
      throw new Error(`step ${index + 1} is missing run`);
    }

    return {
      name: name || `step-${index + 1}`,
      run: command,
    };
  });
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
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

function parseRunRequest(body: unknown): RunRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }

  const input = body as Record<string, unknown>;
  const workflowName =
    typeof input.workflowName === "string" && input.workflowName.trim()
      ? input.workflowName.trim()
      : "default";
  const repository =
    typeof input.repository === "string" && input.repository.trim() ? input.repository.trim() : "";
  const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : "";
  const sha = typeof input.sha === "string" && input.sha.trim() ? input.sha.trim() : undefined;

  if (!repository) {
    throw new Error("repository is required");
  }
  if (!ref) {
    throw new Error("ref is required");
  }

  return {
    workflowName,
    repository,
    ref,
    sha,
    env: normalizeEnv(input.env),
    steps: normalizeSteps(input.steps),
  };
}

export function createApp(config: RunnerConfig, runner: RunnerService) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/status", (c) =>
    c.json({
      service: "ci-runner-lab",
      mode: config.mode,
      runner: runner.getState(),
      recentRuns: runner.listRuns().slice(0, 20),
    }),
  );

  app.get("/runs", (c) =>
    c.json({
      runs: runner.listRuns(),
    }),
  );

  app.get("/runs/:runId", (c) => {
    const run = runner.getRun(c.req.param("runId"));
    if (!run) {
      return c.json({ error: "run not found" }, 404);
    }
    return c.json({ run });
  });

  app.post("/runs", async (c) => {
    try {
      const body = await c.req.json();
      const run = runner.queueRun(parseRunRequest(body));
      return c.json({ queued: true, run }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request";
      return c.json({ error: message }, 400);
    }
  });

  return app;
}
