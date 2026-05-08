import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { justBashSandboxProvider } from "../../../bureau/sandbox";
import { agent } from "../../../bureau/sdk";
import type { AgentProvider } from "../../../pkg/daemons/src/providers/types";
import { ChangeQueries, SessionQueries } from "../db/queries";
import { initInMemoryDatabase } from "../db/schema";
import { runBureauForChange } from "./adapter";

let db: Database;
let changes: ChangeQueries;
let agentSessions: SessionQueries;
let rootDir: string;

beforeEach(async () => {
  db = initInMemoryDatabase();
  changes = new ChangeQueries(db);
  agentSessions = new SessionQueries(db);
  rootDir = await mkdtemp(join(tmpdir(), "ctl-bureau-adapter-"));
});

afterEach(async () => {
  db.close();
  await rm(rootDir, { recursive: true, force: true });
});

describe("runBureauForChange", () => {
  test("runs a bureau agent, records the session under runtime=bureau, and returns the typed output", async () => {
    const change = changes.create({
      org_id: "default",
      repo: "owner/repo",
      branch: "feature-1",
      base_branch: "main",
      head_sha: "abc123",
      created_by: "human",
      delivery_id: "del-1",
    });

    const expected = { kind: "bureau-output", value: 7 };
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        return {
          ok: true,
          payload: expected,
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };
    const definition = agent<{ prompt: string }>()
      .instructions(() => "test")
      .initialInput((ctx) => ctx.input.prompt)
      .build();

    const result = await runBureauForChange<{ prompt: string }, typeof expected>({
      changeId: change.id,
      jobId: null,
      jobType: "test-bureau",
      agentName: "test-agent",
      definition,
      input: { prompt: "hello" },
      args: null,
      deps: {
        agentSessions,
        agentProvider: provider,
        sandboxProvider: justBashSandboxProvider,
        sourceRoot: rootDir,
        maxWallclockMs: 5_000,
      },
    });

    expect(result.output).toEqual(expected);

    const recorded = agentSessions.getLatestByChangeId(change.id);
    expect(recorded).not.toBeNull();
    expect(recorded?.runtime).toBe("bureau");
    expect(recorded?.runtime_session_id).toBe(result.session.meta.sessionId);
    expect(recorded?.status).toBe("completed");
    expect(recorded?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("marks the session as failed when the provider returns ok:false", async () => {
    const change = changes.create({
      org_id: "default",
      repo: "owner/repo",
      branch: "feature-1",
      base_branch: "main",
      head_sha: "abc123",
      created_by: "human",
      delivery_id: "del-2",
    });

    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        return {
          ok: false,
          reason: "provider_error",
          message: "model upstream failed",
          turns: 0,
          tokens: { input: 0, output: 0 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };
    const definition = agent<{ prompt: string }>()
      .instructions(() => "test")
      .initialInput((ctx) => ctx.input.prompt)
      .build();

    const result = await runBureauForChange({
      changeId: change.id,
      jobId: null,
      jobType: "test-bureau",
      agentName: "test-agent",
      definition,
      input: { prompt: "hello" },
      args: null,
      deps: {
        agentSessions,
        agentProvider: provider,
        sandboxProvider: justBashSandboxProvider,
        sourceRoot: rootDir,
        maxWallclockMs: 5_000,
      },
    });

    expect(result.output).toBeUndefined();
    const recorded = agentSessions.getLatestByChangeId(change.id);
    expect(recorded?.status).toBe("failed");
    expect(recorded?.runtime_session_id).toBe(result.session.meta.sessionId);
  });
});
