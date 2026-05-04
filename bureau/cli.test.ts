import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../pkg/daemons/src/providers/types";
import { agent } from "./sdk";
import { runBureauCli } from "./cli";

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
    ]);
  });
});
