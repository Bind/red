import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../../../pkg/daemons/src/providers/types";
import type { TriagePlan, WideRollupRecord } from "../../agents/triage-analyze/agent";
import { justBashSandboxProvider } from "../../sandbox";
import type { TriageProposal } from "../../agents/triage-propose/agent";
import {
  listTriageRuns,
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

describe("listTriageRuns", () => {
  test("returns an empty list when no triage sessions exist", async () => {
    const runs = await listTriageRuns({ sourceRoot: rootDir });
    expect(runs).toEqual([]);
  });

  test("returns plan_ready for an analyze session that has not been decided", async () => {
    const plan: TriagePlan = {
      hypothesis: "Null reference",
      suspectedFiles: ["api/foo.ts"],
      reproductionSteps: [],
      proposedChangeSummary: "Add null check",
      confidence: "medium",
    };
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        return {
          ok: true,
          payload: plan,
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

    const runs = await listTriageRuns({ sourceRoot: rootDir });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(analyzed.session.meta.sessionId);
    expect(runs[0].status).toBe("plan_ready");
    expect(runs[0].plan).toEqual({ hypothesis: plan.hypothesis, confidence: plan.confidence });
    expect(runs[0].rollup.request_id).toBe(sampleRollup.request_id);
    expect(runs[0].rollup.entry_service).toBe(sampleRollup.entry_service);
  });

  test("returns approved status when the decision is approved and no propose session exists", async () => {
    const plan: TriagePlan = {
      hypothesis: "x",
      suspectedFiles: [],
      reproductionSteps: [],
      proposedChangeSummary: "x",
      confidence: "low",
    };
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        return {
          ok: true,
          payload: plan,
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

    const runs = await listTriageRuns({ sourceRoot: rootDir });
    expect(runs[0].status).toBe("approved");
  });

  test("returns proposal_ready and the proposal when a propose child exists", async () => {
    const plan: TriagePlan = {
      hypothesis: "x",
      suspectedFiles: [],
      reproductionSteps: [],
      proposedChangeSummary: "x",
      confidence: "low",
    };
    const proposal: TriageProposal = {
      repoId: "bind/red",
      branch: "agent/fix",
      summary: "fixed",
    };
    let call = 0;
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        call += 1;
        return {
          ok: true,
          payload: call === 1 ? plan : proposal,
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
    await runTriagePropose({ analyzeSessionId: analyzed.session.meta.sessionId, deps });

    const runs = await listTriageRuns({ sourceRoot: rootDir });
    const run = runs.find((r) => r.id === analyzed.session.meta.sessionId);
    expect(run?.status).toBe("proposal_ready");
    expect(run?.proposal).toEqual({
      repo_id: proposal.repoId,
      branch: proposal.branch,
      pr_url: undefined,
    });
  });
});
