import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../pkg/daemons/src/providers/types";
import { createBlobStore } from "./blob-store";
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

  test("populates session.meta.output with the provider's typed payload", async () => {
    const definition = agent<{ prompt: string }>()
      .instructions(() => "test")
      .initialInput((ctx) => ctx.input.prompt)
      .build();

    const expectedPayload = { kind: "custom-output", value: 42 };
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        return {
          ok: true,
          payload: expectedPayload,
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };

    const outcome = await runBureauAgent({
      definition,
      input: { prompt: "hello" },
      args: null,
      provider,
      maxTurns: 1,
      maxWallclockMs: 5_000,
      context: {
        name: "output-test",
        sourceRoot: rootDir,
        root: rootDir,
        cwd: rootDir,
        agentDir: join(rootDir, "bureau", "agents", "output-test"),
        assets: { skills: [] },
        emit() {},
        resolveAsset(p) {
          return join(rootDir, p);
        },
        resolveSharedAsset(p) {
          return join(rootDir, p);
        },
      },
    });

    expect(outcome.session.meta.output).toEqual(expectedPayload);
  });

  test("harvests .bureau-out/ into the blob store and records names on the session meta", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bureau-runtime-cwd-"));
    const blobsDir = await mkdtemp(join(tmpdir(), "bureau-runtime-blobs-"));
    try {
      await mkdir(join(cwd, ".bureau-out"), { recursive: true });
      await writeFile(join(cwd, ".bureau-out", "summary.md"), "summary contents");

      const definition = agent<{ prompt: string }>()
        .instructions(() => "harvest test")
        .initialInput((ctx) => ctx.input.prompt)
        .build();

      const provider: AgentProvider = {
        name: "fake",
        async runUntilComplete(opts) {
          return {
            ok: true,
            payload: { summary: "ok", findings: [] },
            turns: 1,
            tokens: { input: 1, output: 1 },
            session: {
              systemPrompt: opts.systemPrompt,
              messages: [],
            },
          };
        },
      };

      const blobStore = createBlobStore({ kind: "local-fs", rootDir: blobsDir });

      const result = await runBureauAgent({
        definition,
        input: { prompt: "harvest please" },
        args: null,
        provider,
        maxTurns: 1,
        maxWallclockMs: 5_000,
        blobStore,
        context: {
          name: "harvester",
          sourceRoot: rootDir,
          root: rootDir,
          cwd,
          agentDir: join(rootDir, "bureau", "agents", "harvester"),
          assets: { skills: [] },
          emit() {},
          resolveAsset(relativePath) {
            return join(rootDir, "bureau", "agents", "harvester", relativePath);
          },
          resolveSharedAsset(relativePath) {
            return join(rootDir, "bureau", "shared", relativePath);
          },
        },
      });

      expect(result.session.meta.blobs).toEqual(["summary.md"]);

      const blob = await blobStore.get(result.session.meta.sessionId, "summary.md");
      expect(new TextDecoder().decode(blob?.bytes)).toBe("summary contents");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(blobsDir, { recursive: true, force: true });
    }
  });
});
