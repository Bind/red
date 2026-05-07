import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../pkg/daemons/src/providers/types";
import { bureau, createSandbox, justBashSandboxProvider, type BureauSandboxProvider } from "./sandbox";
import { agent } from "./sdk";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-sandbox-test-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const fakeAgentProvider: AgentProvider = {
  name: "fake",
  async runUntilComplete(opts) {
    return {
      ok: true,
      payload: { summary: "ok", findings: [] },
      turns: 1,
      tokens: { input: 1, output: 1 },
      session: { systemPrompt: opts.systemPrompt, messages: [] },
    };
  },
};

const baseContext = (rootDir: string) => ({
  name: "tester",
  sourceRoot: rootDir,
  root: rootDir,
  agentDir: join(rootDir, "bureau", "agents", "tester"),
  assets: { skills: [] },
  emit() {},
  resolveAsset(p: string) {
    return join(rootDir, p);
  },
  resolveSharedAsset(p: string) {
    return join(rootDir, p);
  },
});

describe("createSandbox", () => {
  test("returns a handle with a workspaceDir and a working close()", async () => {
    const sb = await createSandbox({ provider: justBashSandboxProvider });
    try {
      expect(sb.workspaceDir).toBeString();
      expect(sb.workspaceDir.length).toBeGreaterThan(0);
    } finally {
      await sb.close();
    }
  });

  test("close returns a CloseResult, with workspaceRef undefined when no persistence is configured", async () => {
    const sb = await createSandbox({
      provider: justBashSandboxProvider,
      agentProvider: fakeAgentProvider,
      contextBase: baseContext(rootDir),
      maxWallclockMs: 5_000,
    });
    const result = await sb.close();
    expect(result).toEqual({});
    expect(result.workspaceRef).toBeUndefined();
  });

  test(".run executes a Turn against a named Agent and persists a Session", async () => {
    const definition = agent<{ prompt: string }>()
      .instructions(() => "test agent")
      .initialInput((ctx) => ctx.input.prompt)
      .build();

    await using sb = await createSandbox({
      provider: justBashSandboxProvider,
      agentProvider: fakeAgentProvider,
      contextBase: baseContext(rootDir),
      maxWallclockMs: 5_000,
    });

    const outcome = await sb.run({
      definition,
      input: { prompt: "hello" },
      args: null,
      maxTurns: 1,
    });

    expect(outcome.session.meta.agentName).toBe("tester");
    expect(outcome.session.snapshot.systemPrompt).toBe("test agent");
  });

  test("bureau.run executes one Turn and auto-disposes the sandbox", async () => {
    let cleanupCalls = 0;
    const trackingProvider: BureauSandboxProvider = {
      ...justBashSandboxProvider,
      async create(opts) {
        const session = await justBashSandboxProvider.create(opts);
        const originalCleanup = session.cleanup.bind(session);
        return {
          ...session,
          cleanup: async () => {
            cleanupCalls += 1;
            await originalCleanup();
          },
        };
      },
    };

    const definition = agent<{ prompt: string }>()
      .instructions(() => "one shot")
      .initialInput((ctx) => ctx.input.prompt)
      .build();

    const outcome = await bureau.run({
      provider: trackingProvider,
      agentProvider: fakeAgentProvider,
      contextBase: baseContext(rootDir),
      maxWallclockMs: 5_000,
      definition,
      input: { prompt: "hi" },
      args: null,
      maxTurns: 1,
    });

    expect(outcome.session.meta.agentName).toBe("tester");
    expect(cleanupCalls).toBe(1);
  });

  test("await using disposes the sandbox exactly once on block exit", async () => {
    let closeCalls = 0;
    const trackingProvider: BureauSandboxProvider = {
      ...justBashSandboxProvider,
      async create(opts) {
        const session = await justBashSandboxProvider.create(opts);
        const originalCleanup = session.cleanup.bind(session);
        return {
          ...session,
          cleanup: async () => {
            closeCalls += 1;
            await originalCleanup();
          },
        };
      },
    };

    {
      await using sb = await createSandbox({ provider: trackingProvider });
      expect(sb.workspaceDir).toBeString();
    }

    expect(closeCalls).toBe(1);
  });
});
