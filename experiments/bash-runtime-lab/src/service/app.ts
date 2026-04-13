import { Hono } from "hono";
import type { BashRuntimeService } from "./runtime";
import type { BashRuntimeConfig, ExecuteRunRequest } from "../util/types";

function normalizeEnv(input: unknown): Record<string, string> {
  if (input === undefined) {
    return {};
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("env must be an object");
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      throw new Error(`env ${key} must be a string`);
    }
    env[key] = value;
  }
  return env;
}

function normalizeHashes(input: unknown): Record<string, string> {
  if (input === undefined) {
    return {};
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("dependencyHashes must be an object");
  }

  const hashes: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      throw new Error(`dependencyHashes ${key} must be a string`);
    }
    hashes[key] = value;
  }
  return hashes;
}

function parseExecuteRequest(body: unknown): ExecuteRunRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }

  const input = body as Record<string, unknown>;
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  const script = typeof input.script === "string" ? input.script : "";

  if (!runId) {
    throw new Error("runId is required");
  }
  if (!script.trim()) {
    throw new Error("script is required");
  }

  return {
    runId,
    script,
    env: normalizeEnv(input.env),
    dependencyHashes: normalizeHashes(input.dependencyHashes),
  };
}

export function createApp(config: BashRuntimeConfig, runtime: BashRuntimeService) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      dataDir: config.dataDir,
    }),
  );

  app.post("/runs/execute", async (c) => {
    try {
      const body = await c.req.json();
      const result = await runtime.execute(parseExecuteRequest(body));
      return c.json({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid request";
      return c.json({ error: message }, 400);
    }
  });

  app.get("/runs/:runId", async (c) => {
    const record = await runtime.getRun(c.req.param("runId"));
    if (!record) {
      return c.json({ error: "run not found" }, 404);
    }
    return c.json({
      ok: true,
      run: record,
    });
  });

  return app;
}
