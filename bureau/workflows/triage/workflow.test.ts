import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../../../pkg/daemons/src/providers/types";
import type { TriagePlan, WideRollupRecord } from "../../agents/triage-analyze/agent";
import { justBashSandboxProvider } from "../../sandbox";
import type { TriageProposal } from "../../agents/triage-propose/agent";
import {
  markTriageDecision,
  readTriageDecision,
  runTriageAnalyze,
  runTriagePropose,
} from "./workflow";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "triage-workflow-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const sampleRollup: WideRollupRecord = {
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

describe("runTriageAnalyze", () => {
  test("runs the analyze agent and returns a Session with the plan", async () => {
    const expectedPlan: TriagePlan = {
      hypothesis: "Null reference",
      suspectedFiles: ["api/foo.ts"],
      reproductionSteps: ["call /v1/foo"],
      proposedChangeSummary: "Add null check",
      confidence: "medium",
    };

    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        return {
          ok: true,
          payload: expectedPlan,
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };

    const result = await runTriageAnalyze({
      rollup: sampleRollup,
      deps: {
        agentProvider: provider,
        sandboxProvider: justBashSandboxProvider,
        sourceRoot: rootDir,
        maxWallclockMs: 5_000,
      },
    });

    expect(result.session.meta.agentName).toBe("triage-analyze");
    expect(result.plan).toEqual(expectedPlan);
  });
});

describe("markTriageDecision / readTriageDecision", () => {
  test("records and reads back a session decision", async () => {
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        return {
          ok: true,
          payload: {
            hypothesis: "x",
            suspectedFiles: [],
            reproductionSteps: [],
            proposedChangeSummary: "x",
            confidence: "low",
          },
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };
    const analyzed = await runTriageAnalyze({
      rollup: sampleRollup,
      deps: {
        agentProvider: provider,
        sandboxProvider: justBashSandboxProvider,
        sourceRoot: rootDir,
        maxWallclockMs: 5_000,
      },
    });

    await markTriageDecision({
      sessionId: analyzed.session.meta.sessionId,
      decision: "approved",
      sourceRoot: rootDir,
    });

    const decision = await readTriageDecision({
      sessionId: analyzed.session.meta.sessionId,
      sourceRoot: rootDir,
    });

    expect(decision).toMatchObject({ state: "approved" });
    expect(decision?.decidedAt).toBeString();
  });

  test("readTriageDecision returns null for a session that has no decision yet", async () => {
    const decision = await readTriageDecision({
      sessionId: "ses-never-decided",
      sourceRoot: rootDir,
    });
    expect(decision).toBeNull();
  });
});

describe("runTriagePropose", () => {
  test("runs propose using the approved plan from the analyze session", async () => {
    const plan: TriagePlan = {
      hypothesis: "Null reference",
      suspectedFiles: ["api/foo.ts"],
      reproductionSteps: ["call /v1/foo"],
      proposedChangeSummary: "Add null check",
      confidence: "medium",
    };
    const expectedProposal: TriageProposal = {
      repoId: "bind/red",
      branch: "agent/fix-foo",
      summary: "Added null check",
    };

    let call = 0;
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        call += 1;
        const payload = call === 1 ? plan : expectedProposal;
        return {
          ok: true,
          payload,
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };
    const deps = {
      agentProvider: provider,
      sandboxProvider: justBashSandboxProvider,
      sourceRoot: rootDir,
      maxWallclockMs: 5_000,
    };

    const analyzed = await runTriageAnalyze({ rollup: sampleRollup, deps });
    await markTriageDecision({
      sessionId: analyzed.session.meta.sessionId,
      decision: "approved",
      sourceRoot: rootDir,
    });

    const proposed = await runTriagePropose({
      analyzeSessionId: analyzed.session.meta.sessionId,
      deps,
    });

    expect(proposed.session.meta.agentName).toBe("triage-propose");
    expect(proposed.session.meta.parentSessionId).toBe(analyzed.session.meta.sessionId);
    expect(proposed.proposal).toEqual(expectedProposal);
  });

  test("runTriagePropose throws when the analyze session has not been approved", async () => {
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        return {
          ok: true,
          payload: {
            hypothesis: "x",
            suspectedFiles: [],
            reproductionSteps: [],
            proposedChangeSummary: "x",
            confidence: "low",
          },
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };
    const deps = {
      agentProvider: provider,
      sandboxProvider: justBashSandboxProvider,
      sourceRoot: rootDir,
      maxWallclockMs: 5_000,
    };
    const analyzed = await runTriageAnalyze({ rollup: sampleRollup, deps });

    await expect(
      runTriagePropose({ analyzeSessionId: analyzed.session.meta.sessionId, deps }),
    ).rejects.toThrow(/not.*approved/i);
  });
});
