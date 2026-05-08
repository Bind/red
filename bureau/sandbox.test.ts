import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../pkg/daemons/src/providers/types";
import { bureau, createSandbox, justBashSandboxProvider, type BureauSandboxProvider } from "./sandbox";
import { LocalScratchRepo } from "./scratch-repo";
import { agent, type BureauAgentInstance } from "./sdk";
import { createLocalBureauSessionStore } from "./session-store";

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
  sessionRoot: rootDir,
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

  test("bureau.run accepts a first-class agent instance", async () => {
    const instance: BureauAgentInstance<{ prompt: string }, { prompt: string }> = {
      name: "tester",
      args: { prompt: "hello from instance" },
      definition: agent<{ prompt: string }>()
        .instructions(() => "instance agent")
        .initialInput((ctx) => ctx.input.prompt)
        .build(),
      context: baseContext(rootDir),
      buildInput() {
        return { prompt: "hello from instance" };
      },
    };

    const outcome = await bureau.run({
      provider: justBashSandboxProvider,
      agentProvider: fakeAgentProvider,
      maxWallclockMs: 5_000,
      agent: instance,
      maxTurns: 1,
    });

    expect(outcome.session.meta.agentName).toBe("tester");
    expect(outcome.session.meta.args).toEqual({ prompt: "hello from instance" });
    expect(outcome.session.snapshot.systemPrompt).toBe("instance agent");
  });

  test("bureau.run materializes the agent source tree into the sandbox workspace", async () => {
    await writeFile(join(rootDir, "tracked.txt"), "copied into sandbox");

    let providerCwd = "";
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        providerCwd = opts.cwd;
        return {
          ok: true,
          payload: { summary: "ok", findings: [] },
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };

    const instance: BureauAgentInstance<null, null> = {
      name: "tester",
      args: null,
      definition: agent<null>()
        .plan(async (ctx) => {
          const copied = await readFile(join(ctx.root, "tracked.txt"), "utf8");
          expect(copied).toBe("copied into sandbox");
          return {
            systemPrompt: "instance agent",
            initialInput: "check copied source",
            cwd: ctx.root,
          };
        })
        .build(),
      context: baseContext(rootDir),
      buildInput() {
        return null;
      },
    };

    const outcome = await bureau.run({
      provider: justBashSandboxProvider,
      agentProvider: provider,
      maxWallclockMs: 5_000,
      agent: instance,
      maxTurns: 1,
    });

    expect(outcome.session.meta.agentName).toBe("tester");
    expect(providerCwd).toContain("/workspace");
  });

  test("bureau.resume accepts a first-class agent instance", async () => {
    const store = createLocalBureauSessionStore({ rootDir });
    const parent = await store.createRoot({
      agentName: "tester",
      args: { prompt: "root prompt" },
      mode: "run",
      snapshot: {
        version: 1,
        systemPrompt: "persisted prompt",
        messages: [
          { role: "user", content: "parent hello" },
          { role: "assistant", content: "parent done" },
        ],
      },
    });

    const instance: BureauAgentInstance<{ prompt: string }, { prompt: string }> = {
      name: "tester",
      args: { prompt: "resume prompt" },
      definition: agent<{ prompt: string }>()
        .instructions(() => "resume agent")
        .initialInput((ctx) => ctx.input.prompt)
        .build(),
      context: baseContext(rootDir),
      buildInput(userInput) {
        return { prompt: userInput ?? "resume prompt" };
      },
    };

    const outcome = await bureau.resume({
      provider: justBashSandboxProvider,
      agentProvider: fakeAgentProvider,
      maxWallclockMs: 5_000,
      agent: instance,
      parentSession: parent,
      userInput: "child hello",
      maxTurns: 1,
    });

    expect(outcome.session.meta.parentSessionId).toBe(parent.meta.sessionId);
    expect(outcome.session.snapshot.systemPrompt).toBe("persisted prompt");
  });

  test("close commits workspace edits to the scratch repo and returns workspaceRef", async () => {
    const scratchDir = join(rootDir, "scratch.git");
    const scratchRepo = new LocalScratchRepo({ rootDir: scratchDir });

    const sb = await createSandbox({
      provider: justBashSandboxProvider,
      agentProvider: fakeAgentProvider,
      contextBase: baseContext(rootDir),
      maxWallclockMs: 5_000,
      workspaceRepo: scratchRepo,
      sessionId: "ses-abc",
    });

    await writeFile(join(sb.workspaceDir, "hello.txt"), "world");
    const result = await sb.close();

    expect(result.workspaceRef).toBeString();
    expect(result.workspaceRef!.length).toBeGreaterThan(0);
  });

  test("createSandbox with resumeFrom restores prior workspace contents", async () => {
    const scratchDir = join(rootDir, "scratch.git");
    const scratchRepo = new LocalScratchRepo({ rootDir: scratchDir });

    const first = await createSandbox({
      provider: justBashSandboxProvider,
      agentProvider: fakeAgentProvider,
      contextBase: baseContext(rootDir),
      maxWallclockMs: 5_000,
      workspaceRepo: scratchRepo,
      sessionId: "ses-abc",
    });
    await writeFile(join(first.workspaceDir, "hello.txt"), "world");
    const firstResult = await first.close();

    const second = await createSandbox({
      provider: justBashSandboxProvider,
      agentProvider: fakeAgentProvider,
      contextBase: baseContext(rootDir),
      maxWallclockMs: 5_000,
      workspaceRepo: scratchRepo,
      resumeFrom: firstResult.workspaceRef,
    });

    try {
      const restoredPath = join(second.workspaceDir, "hello.txt");
      expect(existsSync(restoredPath)).toBe(true);
      expect(await readFile(restoredPath, "utf8")).toBe("world");
    } finally {
      await second.close();
    }
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
