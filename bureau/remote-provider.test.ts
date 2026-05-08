import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLibrarianAgentInstance } from "./agents/librarian/agent";
import { createTriageProposeAgentInstance } from "./agents/triage-propose/agent";
import { createRemoteBureauProvider } from "./remote-provider";
import { bureau, justBashSandboxProvider } from "./sandbox";
import { createLocalBureauSessionStore } from "./session-store";

const TEST_IMAGE = "oven/bun:1";

let dockerAvailable = false;

beforeAll(async () => {
  dockerAvailable = await canRun(["docker", "info"]);
  if (!dockerAvailable) return;
  await runOrThrow(["docker", "pull", TEST_IMAGE]);
}, 60_000);

describe("createRemoteBureauProvider", () => {
  test("runs a first-class agent through bureau.run inside the container", async () => {
    if (!dockerAvailable) return;

    const rootDir = await mkdtemp(join(tmpdir(), "remote-bureau-run-"));
    try {
      const provider = createRemoteBureauProvider({
        runtime: "docker",
        image: TEST_IMAGE,
        repoRoot: resolve(process.cwd()),
      });
      const agent = createLibrarianAgentInstance(
        {
          file: "apps/ctl/index.ts",
          fileSummary: "CLI entrypoint",
          candidates: [],
        },
        resolve(process.cwd()),
      );

      const outcome = await bureau.run({
        provider: justBashSandboxProvider,
        agentProvider: provider,
        agent,
        maxTurns: 1,
        maxWallclockMs: 5_000,
      });

      expect(outcome.result.ok).toBe(true);
      expect(outcome.session.meta.agentName).toBe("librarian");
      expect(outcome.session.snapshot.systemPrompt).toContain("routing librarian");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 120_000);

  test("resumes a first-class agent through bureau.resume inside the container", async () => {
    if (!dockerAvailable) return;

    const rootDir = await mkdtemp(join(tmpdir(), "remote-bureau-resume-"));
    try {
      const provider = createRemoteBureauProvider({
        runtime: "docker",
        image: TEST_IMAGE,
        repoRoot: resolve(process.cwd()),
      });
      const store = createLocalBureauSessionStore({ rootDir });
      const parent = await store.createRoot({
        agentName: "triage-analyze",
        args: { rollup: { request_id: "req-1" } },
        mode: "run",
        snapshot: {
          version: 1,
          systemPrompt: "persisted prompt",
          messages: [{ role: "user", content: "parent hello" }],
        },
        output: {
          hypothesis: "Null reference",
          suspectedFiles: ["api/foo.ts"],
          reproductionSteps: ["call /v1/foo"],
          proposedChangeSummary: "Add null check",
          confidence: "medium",
        },
      });

      const agent = createTriageProposeAgentInstance(
        {
          plan: parent.meta.output as Parameters<typeof createTriageProposeAgentInstance>[0]["plan"],
        },
        resolve(process.cwd()),
      );

      const outcome = await bureau.resume({
        provider: justBashSandboxProvider,
        agentProvider: provider,
        agent,
        parentSession: parent,
        maxTurns: 1,
        maxWallclockMs: 5_000,
      });

      expect(outcome.result.ok).toBe(true);
      expect(outcome.session.meta.agentName).toBe("triage-propose");
      expect(outcome.session.meta.parentSessionId).toBe(parent.meta.sessionId);
      expect(outcome.session.snapshot.systemPrompt).toBe("persisted prompt");
      expect(outcome.session.snapshot.messages).toEqual([
        { role: "user", content: "parent hello" },
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 120_000);
});

async function canRun(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function runOrThrow(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${stderr || stdout}`);
  }
}
