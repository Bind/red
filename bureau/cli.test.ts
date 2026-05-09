import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../pkg/daemons/src/providers/types";
import { agent } from "./sdk";
import { runBureauCli } from "./cli";
import { createLocalBureauSessionStore } from "./session-store";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-cli-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("runBureauCli", () => {
  test("runs a fresh one-shot agent session and persists the root session", async () => {
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: {
            summary: "completed from bureau cli",
            findings: [],
          },
          turns: 1,
          tokens: { input: 4, output: 9 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: "done" },
            ],
          },
        };
      },
    };

    const code = await runBureauCli(
      [
        "run",
        "echo-agent",
        "--args",
        '{"topic":"bureau"}',
        "--input",
        "hello from bureau run",
      ],
      {
        cwd: rootDir,
        provider,
        resolveAgent: async ({ agentName, args, root }) => ({
          agentName,
          args,
          definition: agent<string>()
            .instructions("You are a bureau CLI test agent.")
            .initialInput((ctx) => ctx.input)
            .build(),
          context: {
            name: agentName,
            sourceRoot: root,
            sessionRoot: root,
            root,
            cwd: root,
            agentDir: join(root, "bureau", "agents", agentName),
            assets: { skills: [] },
            emit() {},
            resolveAsset(relativePath: string) {
              return join(root, "bureau", "agents", agentName, relativePath);
            },
            resolveSharedAsset(relativePath: string) {
              return join(root, "bureau", "shared", relativePath);
            },
          },
          buildInput(userInput: string | null) {
            return userInput ?? "";
          },
        }),
        stdout() {},
        stderr() {},
      },
    );

    expect(code).toBe(0);

    const sessionsRoot = join(rootDir, ".bureau", "sessions");
    const sessionIds = await readdir(sessionsRoot);
    expect(sessionIds).toHaveLength(1);

    const meta = JSON.parse(await readFile(join(sessionsRoot, sessionIds[0]!, "meta.json"), "utf8"));
    const session = JSON.parse(
      await readFile(join(sessionsRoot, sessionIds[0]!, "session.json"), "utf8"),
    );

    expect(meta.agentName).toBe("echo-agent");
    expect(meta.args).toEqual({ topic: "bureau" });
    expect(session.messages).toEqual([
      { role: "user", content: "hello from bureau run" },
      { role: "assistant", content: "done" },
    ]);
  });

  test("prompts for the first user turn when --input is absent and persists the resulting root session", async () => {
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: {
            summary: "completed from interactive bureau cli",
            findings: [],
          },
          turns: 1,
          tokens: { input: 2, output: 5 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: "done" },
            ],
          },
        };
      },
    };

    let prompted = false;
    const code = await runBureauCli(
      ["run", "echo-agent"],
      {
        cwd: rootDir,
        provider,
        resolveAgent: async ({ agentName, args, root }) => ({
          agentName,
          args,
          definition: agent<string>()
            .instructions("You are a bureau CLI test agent.")
            .initialInput((ctx) => ctx.input)
            .build(),
          context: {
            name: agentName,
            sourceRoot: root,
            sessionRoot: root,
            root,
            cwd: root,
            agentDir: join(root, "bureau", "agents", agentName),
            assets: { skills: [] },
            emit() {},
            resolveAsset(relativePath: string) {
              return join(root, "bureau", "agents", agentName, relativePath);
            },
            resolveSharedAsset(relativePath: string) {
              return join(root, "bureau", "shared", relativePath);
            },
          },
          buildInput(userInput: string | null) {
            return userInput ?? "";
          },
        }),
        prompt: async () => {
          prompted = true;
          return "interactive hello";
        },
        stdout() {},
        stderr() {},
      },
    );

    expect(code).toBe(0);
    expect(prompted).toBe(true);

    const sessionsRoot = join(rootDir, ".bureau", "sessions");
    const sessionIds = await readdir(sessionsRoot);
    expect(sessionIds).toHaveLength(1);

    const session = JSON.parse(
      await readFile(join(sessionsRoot, sessionIds[0]!, "session.json"), "utf8"),
    );

    expect(session.messages[0]).toEqual({ role: "user", content: "interactive hello" });
  });

  test("streams progress and tool events inline during a bureau run", async () => {
    const lines: string[] = [];
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        opts.onTurnStart?.(1);
        opts.onToolCall?.(1, "read", { path: "README.md" });
        opts.onTurnEnd?.(1, {
          tokens: { input: 3, output: 8 },
          completeCalled: true,
        });
        return {
          ok: true,
          payload: {
            summary: "completed with streamed events",
            findings: [],
          },
          turns: 1,
          tokens: { input: 3, output: 8 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: "done" },
            ],
          },
        };
      },
    };

    const code = await runBureauCli(
      ["run", "echo-agent", "--input", "stream me"],
      {
        cwd: rootDir,
        provider,
        resolveAgent: async ({ agentName, args, root }) => ({
          agentName,
          args,
          definition: agent<string>()
            .instructions("You are a bureau CLI test agent.")
            .initialInput((ctx) => ctx.input)
            .build(),
          context: {
            name: agentName,
            sourceRoot: root,
            sessionRoot: root,
            root,
            cwd: root,
            agentDir: join(root, "bureau", "agents", agentName),
            assets: { skills: [] },
            emit() {},
            resolveAsset(relativePath: string) {
              return join(root, "bureau", "agents", agentName, relativePath);
            },
            resolveSharedAsset(relativePath: string) {
              return join(root, "bureau", "shared", relativePath);
            },
          },
          buildInput(userInput: string | null) {
            return userInput ?? "";
          },
        }),
        stdout(line: string) {
          lines.push(line);
        },
        stderr() {},
      },
    );

    expect(code).toBe(0);
    expect(lines).toEqual([
      "turn.started 1",
      'tool.called 1 read {"path":"README.md"}',
      "turn.completed 1 input=3 output=8 complete=true",
      "done",
    ]);
  });

  test("prints the assistant reply after a bureau run completes", async () => {
    const lines: string[] = [];
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: {
            summary: "completed with visible assistant text",
            findings: [],
          },
          turns: 1,
          tokens: { input: 3, output: 8 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: [{ type: "text", text: "hello from agent" }] },
            ],
          },
        };
      },
    };

    const code = await runBureauCli(
      ["run", "echo-agent", "--input", "say hello"],
      {
        cwd: rootDir,
        provider,
        resolveAgent: async ({ agentName, args, root }) => ({
          agentName,
          args,
          definition: agent<string>()
            .instructions("You are a bureau CLI test agent.")
            .initialInput((ctx) => ctx.input)
            .build(),
          context: {
            name: agentName,
            sourceRoot: root,
            sessionRoot: root,
            root,
            cwd: root,
            agentDir: join(root, "bureau", "agents", agentName),
            assets: { skills: [] },
            emit() {},
            resolveAsset(relativePath: string) {
              return join(root, "bureau", "agents", agentName, relativePath);
            },
            resolveSharedAsset(relativePath: string) {
              return join(root, "bureau", "shared", relativePath);
            },
          },
          buildInput(userInput: string | null) {
            return userInput ?? "";
          },
        }),
        stdout(line: string) {
          lines.push(line);
        },
        stderr() {},
      },
    );

    expect(code).toBe(0);
    expect(lines.at(-1)).toBe("hello from agent");
  });

  test("streams assistant text inline before later lifecycle lines", async () => {
    const events: string[] = [];
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        opts.onTurnStart?.(1);
        opts.onAssistantTextDelta?.(1, "hello ");
        opts.onAssistantTextDelta?.(1, "inline");
        opts.onTurnEnd?.(1, {
          tokens: { input: 3, output: 8 },
          completeCalled: true,
        });
        return {
          ok: true,
          payload: {
            summary: "completed with inline assistant text",
            findings: [],
          },
          turns: 1,
          tokens: { input: 3, output: 8 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: [{ type: "text", text: "hello inline" }] },
            ],
          },
        };
      },
    };

    const code = await runBureauCli(
      ["run", "echo-agent", "--input", "say hello inline"],
      {
        cwd: rootDir,
        provider,
        resolveAgent: async ({ agentName, args, root }) => ({
          agentName,
          args,
          definition: agent<string>()
            .instructions("You are a bureau CLI test agent.")
            .initialInput((ctx) => ctx.input)
            .build(),
          context: {
            name: agentName,
            sourceRoot: root,
            sessionRoot: root,
            root,
            cwd: root,
            agentDir: join(root, "bureau", "agents", agentName),
            assets: { skills: [] },
            emit() {},
            resolveAsset(relativePath: string) {
              return join(root, "bureau", "agents", agentName, relativePath);
            },
            resolveSharedAsset(relativePath: string) {
              return join(root, "bureau", "shared", relativePath);
            },
          },
          buildInput(userInput: string | null) {
            return userInput ?? "";
          },
        }),
        stdout(line: string) {
          events.push(`line:${line}`);
        },
        stdoutText(chunk: string) {
          events.push(`text:${chunk}`);
        },
        stderr() {},
      },
    );

    expect(code).toBe(0);
    expect(events).toEqual([
      "line:turn.started 1",
      "text:hello ",
      "text:inline",
      "text:\n",
      "line:turn.completed 1 input=3 output=8 complete=true",
    ]);
  });

  test("resumes a parent session into a new child session without mutating the parent", async () => {
    const store = createLocalBureauSessionStore({ rootDir });
    const parent = await store.createRoot({
      agentName: "echo-agent",
      args: { topic: "bureau" },
      mode: "run",
      snapshot: {
        version: 1,
        systemPrompt: "Persisted parent prompt.",
        messages: [
          { role: "user", content: "parent hello" },
          { role: "assistant", content: "parent done" },
        ],
      },
    });
    const parentSessionPath = join(
      rootDir,
      ".bureau",
      "sessions",
      parent.meta.sessionId,
      "session.json",
    );
    const parentBefore = await readFile(parentSessionPath, "utf8");

    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: {
            summary: "completed from bureau resume",
            findings: [],
          },
          turns: 1,
          tokens: { input: 5, output: 7 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              ...(opts.messages ?? []),
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: "child done" },
            ],
          },
        };
      },
    };

    const code = await runBureauCli(
      ["resume", parent.meta.sessionId, "--input", "child hello"],
      {
        cwd: rootDir,
        provider,
        resolveAgent: async ({ agentName, args, root }) => ({
          agentName,
          args,
          definition: agent<string>()
            .instructions("Current resolver prompt should not replace the parent prompt.")
            .initialInput((ctx) => ctx.input)
            .build(),
          context: {
            name: agentName,
            sourceRoot: root,
            sessionRoot: root,
            root,
            cwd: root,
            agentDir: join(root, "bureau", "agents", agentName),
            assets: { skills: [] },
            emit() {},
            resolveAsset(relativePath: string) {
              return join(root, "bureau", "agents", agentName, relativePath);
            },
            resolveSharedAsset(relativePath: string) {
              return join(root, "bureau", "shared", relativePath);
            },
          },
          buildInput(userInput: string | null) {
            return userInput ?? "";
          },
        }),
        stdout() {},
        stderr() {},
      },
    );

    expect(code).toBe(0);

    const sessionsRoot = join(rootDir, ".bureau", "sessions");
    const sessionIds = await readdir(sessionsRoot);
    expect(sessionIds).toHaveLength(2);

    const childId = sessionIds.find((id) => id !== parent.meta.sessionId);
    expect(childId).toBeString();

    const childMeta = JSON.parse(await readFile(join(sessionsRoot, childId!, "meta.json"), "utf8"));
    const childSession = JSON.parse(await readFile(join(sessionsRoot, childId!, "session.json"), "utf8"));

    expect(childMeta.parentSessionId).toBe(parent.meta.sessionId);
    expect(childMeta.agentName).toBe("echo-agent");
    expect(childSession.systemPrompt).toBe("Persisted parent prompt.");
    expect(childSession.messages).toEqual([
      { role: "user", content: "parent hello" },
      { role: "assistant", content: "parent done" },
      { role: "user", content: "child hello" },
      { role: "assistant", content: "child done" },
    ]);

    expect(await readFile(parentSessionPath, "utf8")).toBe(parentBefore);
  });

  test("prompts for the first new turn when resuming without --input", async () => {
    const store = createLocalBureauSessionStore({ rootDir });
    const parent = await store.createRoot({
      agentName: "echo-agent",
      args: null,
      mode: "run",
      snapshot: {
        version: 1,
        systemPrompt: "Persisted parent prompt.",
        messages: [{ role: "user", content: "parent hello" }],
      },
    });

    let prompted = false;
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: {
            summary: "completed from prompted resume",
            findings: [],
          },
          turns: 1,
          tokens: { input: 2, output: 6 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              ...(opts.messages ?? []),
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: "child prompted done" },
            ],
          },
        };
      },
    };

    const code = await runBureauCli(
      ["resume", parent.meta.sessionId],
      {
        cwd: rootDir,
        provider,
        resolveAgent: async ({ agentName, args, root }) => ({
          agentName,
          args,
          definition: agent<string>()
            .instructions("Current resolver prompt should not replace the parent prompt.")
            .initialInput((ctx) => ctx.input)
            .build(),
          context: {
            name: agentName,
            sourceRoot: root,
            sessionRoot: root,
            root,
            cwd: root,
            agentDir: join(root, "bureau", "agents", agentName),
            assets: { skills: [] },
            emit() {},
            resolveAsset(relativePath: string) {
              return join(root, "bureau", "agents", agentName, relativePath);
            },
            resolveSharedAsset(relativePath: string) {
              return join(root, "bureau", "shared", relativePath);
            },
          },
          buildInput(userInput: string | null) {
            return userInput ?? "";
          },
        }),
        prompt: async () => {
          prompted = true;
          return "prompted child hello";
        },
        stdout() {},
        stderr() {},
      },
    );

    expect(code).toBe(0);
    expect(prompted).toBe(true);

    const sessionsRoot = join(rootDir, ".bureau", "sessions");
    const sessionIds = await readdir(sessionsRoot);
    const childId = sessionIds.find((id) => id !== parent.meta.sessionId);
    expect(childId).toBeString();

    const childSession = JSON.parse(await readFile(join(sessionsRoot, childId!, "session.json"), "utf8"));
    expect(childSession.messages).toEqual([
      { role: "user", content: "parent hello" },
      { role: "user", content: "prompted child hello" },
      { role: "assistant", content: "child prompted done" },
    ]);
  });
});
