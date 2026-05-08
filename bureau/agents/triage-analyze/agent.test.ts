import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, ProviderRunOptions } from "../../../pkg/daemons/src/providers/types";
import { runBureauAgent } from "../../runtime";
import {
  buildTriageAnalyzeContext,
  triageAnalyze,
  type TriagePlan,
  type WideRollupRecord,
} from "./agent";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "triage-analyze-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("triageAnalyze", () => {
  test("produces a TriagePlan payload from a WideRollupRecord", async () => {
    const rollup: WideRollupRecord = {
      request_id: "req-1",
      first_ts: "2024-01-01T00:00:00Z",
      last_ts: "2024-01-01T00:00:01Z",
      total_duration_ms: 1000,
      entry_service: "api",
      services: ["api", "db"],
      route_names: ["/v1/foo"],
      final_outcome: "error",
      final_status_code: 500,
      primary_error: { name: "NullPointer", message: "..." },
      events: [],
    };
    const expected: TriagePlan = {
      hypothesis: "Null reference in foo handler",
      suspectedFiles: ["api/foo.ts"],
      reproductionSteps: ["call /v1/foo with empty body"],
      proposedChangeSummary: "Add null check",
      confidence: "medium",
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
      definition: triageAnalyze(),
      input: rollup,
      args: { rollupId: "req-1" },
      provider,
      maxTurns: 1,
      maxWallclockMs: 5_000,
      context: buildTriageAnalyzeContext(rootDir),
    });

    expect(outcome.session.meta.agentName).toBe("triage-analyze");
    expect(outcome.result.payload).toEqual(expected);
    expect(captured?.systemPrompt).toContain("triage");
    expect(captured?.initialInput).toContain("req-1");
  });
});
