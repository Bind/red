import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../../../pkg/daemons/src/providers/types";
import { bureau, justBashSandboxProvider } from "../../sandbox";
import { createLibrarianAgentInstance } from "./agent";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-librarian-instance-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createLibrarianAgentInstance", () => {
  test("returns a first-class agent instance usable with bureau.run", async () => {
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: { summary: "done", findings: [] },
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [{ role: "user", content: opts.initialInput }],
          },
        };
      },
    };

    const agent = createLibrarianAgentInstance(
      {
        file: "apps/ctl/index.ts",
        fileSummary: "CLI entrypoint",
        candidates: [],
      },
      rootDir,
    );

    const outcome = await bureau.run({
      provider: justBashSandboxProvider,
      agentProvider: provider,
      agent,
      maxTurns: 1,
      maxWallclockMs: 5_000,
    });

    expect(agent.name).toBe("librarian");
    expect(outcome.session.meta.agentName).toBe("librarian");
    expect(outcome.session.meta.args).toEqual({
      file: "apps/ctl/index.ts",
      fileSummary: "CLI entrypoint",
      candidates: [],
    });
    expect(outcome.session.snapshot.systemPrompt).toContain("routing librarian");
  });
});
