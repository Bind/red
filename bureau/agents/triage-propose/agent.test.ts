import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions } from "../../../pkg/daemons/src/providers/types";
import { runBureauAgent } from "../../runtime";
import type { TriagePlan } from "../triage-analyze/agent";
import {
  buildTriageProposeContext,
  triagePropose,
  type TriageProposal,
} from "./agent";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "triage-propose-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("triagePropose", () => {
  test("produces a TriageProposal payload from an approved TriagePlan", async () => {
    const plan: TriagePlan = {
      hypothesis: "Null reference in foo handler",
      suspectedFiles: ["api/foo.ts"],
      reproductionSteps: ["call /v1/foo with empty body"],
      proposedChangeSummary: "Add null check",
      confidence: "medium",
    };
    const expected: TriageProposal = {
      repoId: "bind/red",
      branch: "agent/fix-foo",
      summary: "Added null check to foo handler",
    };

    let captured: ProviderRunOptions | undefined;
    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts) {
        captured = opts;
        return {
          ok: true,
          payload: expected,
          turns: 1,
          tokens: { input: 1, output: 1 },
          session: { systemPrompt: opts.systemPrompt, messages: [] },
        };
      },
    };

    const outcome = await runBureauAgent({
      definition: triagePropose(),
      input: { plan },
      args: null,
      provider,
      maxTurns: 1,
      maxWallclockMs: 5_000,
      context: buildTriageProposeContext(rootDir),
    });

    expect(outcome.session.meta.agentName).toBe("triage-propose");
    expect(outcome.result.payload).toEqual(expected);
    expect(captured?.initialInput).toContain("Approved plan");
    expect(captured?.initialInput).toContain("Null reference in foo handler");
  });
});
