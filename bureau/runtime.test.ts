import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../pkg/daemons/src/providers/types";
import { agent } from "./sdk";
import { runBureauAgent } from "./runtime";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-runtime-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("runBureauAgent", () => {
  test("persists a root bureau session from the provider session snapshot", async () => {
    let capturedSessionId = "";
    let providerOpts: ProviderRunOptions | undefined;
    const definition = agent<{ prompt: string }>()
      .instructions((ctx) => {
        capturedSessionId = ctx.sessionId;
        return "You are a bureau runtime test agent.";
      })
      .initialInput((ctx) => ctx.input.prompt)
      .build();

    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        providerOpts = opts;
        return {
          ok: true,
          payload: {
            summary: "completed runtime test",
            findings: [],
          },
          turns: 1,
          tokens: { input: 3, output: 5 },
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

    const result = await runBureauAgent({
      definition,
      input: { prompt: "hello runtime" },
      args: { daemonName: "docs-command-surface" },
      provider,
      maxTurns: 2,
      maxWallclockMs: 5_000,
      context: {
        name: "daemon-executor",
        sourceRoot: rootDir,
        root: rootDir,
        cwd: rootDir,
        agentDir: join(rootDir, "bureau", "agents", "daemon-executor"),
        assets: { skills: [] },
        emit() {},
        resolveAsset(relativePath) {
          return join(rootDir, "bureau", "agents", "daemon-executor", relativePath);
        },
        resolveSharedAsset(relativePath) {
          return join(rootDir, "bureau", "shared", relativePath);
        },
      },
    });

    expect(providerOpts?.systemPrompt).toBe("You are a bureau runtime test agent.");
    expect(providerOpts?.initialInput).toBe("hello runtime");
    expect(result.session.meta.sessionId).toBe(capturedSessionId);
    expect(result.session.meta.agentName).toBe("daemon-executor");
    expect(result.session.snapshot).toEqual({
      version: 1,
      systemPrompt: "You are a bureau runtime test agent.",
      messages: [
        { role: "user", content: "hello runtime" },
        { role: "assistant", content: "done" },
      ],
    });
  });
});
