import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../../../pkg/daemons/src/providers/types";
import { bureau, justBashSandboxProvider } from "../../sandbox";
import { createTriageAnalyzeAgentInstance, type TriagePlan, type WideRollupRecord } from "./agent";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "triage-analyze-instance-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createTriageAnalyzeAgentInstance", () => {
  test("returns a first-class agent instance usable with bureau.run", async () => {
    const rollup: WideRollupRecord = {
      request_id: "req-1",
      first_ts: "2024-01-01T00:00:00Z",
      last_ts: "2024-01-01T00:00:01Z",
      total_duration_ms: 1000,
      entry_service: "api",
      services: ["api"],
      route_names: ["/v1/foo"],
      final_outcome: "error",
      final_status_code: 500,
      primary_error: { name: "NullPointer" },
      events: [],
    };
    const expectedPlan: TriagePlan = {
      hypothesis: "Null reference",
      suspectedFiles: ["api/foo.ts"],
      reproductionSteps: ["call /v1/foo"],
      proposedChangeSummary: "Add null check",
      confidence: "medium",
    };
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: expectedPlan,
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };

    const agent = createTriageAnalyzeAgentInstance(rollup, rootDir);
    const outcome = await bureau.run({
      provider: justBashSandboxProvider,
      agentProvider: provider,
      agent,
      maxTurns: 1,
      maxWallclockMs: 5_000,
    });

    expect(agent.name).toBe("triage-analyze");
    expect(outcome.session.meta.agentName).toBe("triage-analyze");
    expect(outcome.session.meta.args).toEqual({ rollup });
    expect(outcome.result.payload).toEqual(expectedPlan);
  });
});
