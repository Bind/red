import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../../../pkg/daemons/src/providers/types";
import { bureau, justBashSandboxProvider } from "../../sandbox";
import { createLocalBureauSessionStore } from "../../session-store";
import type { TriagePlan } from "../triage-analyze/agent";
import { createTriageProposeAgentInstance, type TriageProposal } from "./agent";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "triage-propose-instance-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createTriageProposeAgentInstance", () => {
  test("returns a first-class agent instance usable with bureau.resume", async () => {
    const parentStore = createLocalBureauSessionStore({ rootDir });
    const parent = await parentStore.createRoot({
      agentName: "triage-analyze",
      args: { rollup: { request_id: "req-1" } },
      mode: "run",
      snapshot: {
        version: 1,
        systemPrompt: "persisted prompt",
        messages: [{ role: "user", content: "parent" }],
      },
      output: {
        hypothesis: "Null reference",
        suspectedFiles: ["api/foo.ts"],
        reproductionSteps: ["call /v1/foo"],
        proposedChangeSummary: "Add null check",
        confidence: "medium",
      } satisfies TriagePlan,
    });
    const expectedProposal: TriageProposal = {
      repoId: "bind/red",
      branch: "agent/fix-foo",
      summary: "Added null check",
    };
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: expectedProposal,
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: opts.messages ?? [] },
        };
      },
    };

    const agent = createTriageProposeAgentInstance({ plan: parent.meta.output as TriagePlan }, rootDir);
    const outcome = await bureau.resume({
      provider: justBashSandboxProvider,
      agentProvider: provider,
      agent,
      parentSession: parent,
      maxTurns: 1,
      maxWallclockMs: 5_000,
    });

    expect(agent.name).toBe("triage-propose");
    expect(outcome.session.meta.agentName).toBe("triage-propose");
    expect(outcome.session.meta.parentSessionId).toBe(parent.meta.sessionId);
    expect(outcome.result.payload).toEqual(expectedProposal);
  });
});
