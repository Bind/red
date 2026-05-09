import { join, resolve } from "node:path";
import type { WideRollupRecord } from "../../../pkg/obs/src/wide-events";
import { agent, type BureauAgentContext, type BureauAgentInstance } from "../../sdk";
export type { WideRollupRecord } from "../../../pkg/obs/src/wide-events";

export type TriagePlan = {
  hypothesis: string;
  suspectedFiles: string[];
  reproductionSteps: string[];
  proposedChangeSummary: string;
  confidence: "low" | "medium" | "high";
};

const TRIAGE_ANALYZE_INSTRUCTIONS = [
  "You are a triage agent.",
  "Given an aggregated request rollup that ended in an error or unexpected outcome,",
  "produce a hypothesis about the root cause, list suspected files in the codebase,",
  "outline reproduction steps, summarize a proposed change, and set a confidence level.",
  "Call complete exactly once with a structured TriagePlan.",
].join(" ");

export function triageAnalyze() {
  return agent<WideRollupRecord>()
    .instructions(TRIAGE_ANALYZE_INSTRUCTIONS)
    .initialInput((ctx) => describeRollup(ctx.input))
    .build();
}

function describeRollup(rollup: WideRollupRecord): string {
  const lines = [
    `Request ${rollup.request_id} ended in ${rollup.final_outcome}.`,
    `Entry service: ${rollup.entry_service}.`,
    `Final status code: ${rollup.final_status_code ?? "(none)"}.`,
    `Services: ${rollup.services.join(", ")}.`,
    `Routes: ${rollup.route_names.join(", ")}.`,
  ];
  if (rollup.primary_error) {
    lines.push(`Primary error: ${JSON.stringify(rollup.primary_error)}`);
  }
  lines.push(`Total duration: ${rollup.total_duration_ms}ms across ${rollup.events.length} events.`);
  return lines.join("\n");
}

export function buildTriageAnalyzeContext(
  cwd: string,
): Omit<BureauAgentContext<WideRollupRecord>, "sessionId" | "input"> {
  const root = resolve(cwd);
  const agentDir = join(root, "bureau", "agents", "triage-analyze");
  return {
    name: "triage-analyze",
    sourceRoot: root,
    sessionRoot: root,
    root,
    cwd: root,
    agentDir,
    assets: { skills: [] },
    emit() {},
    resolveAsset(relativePath: string) {
      return join(agentDir, relativePath);
    },
    resolveSharedAsset(relativePath: string) {
      return join(root, "bureau", "shared", relativePath);
    },
  };
}

export function createTriageAnalyzeAgentInstance(
  rollup: WideRollupRecord,
  cwd: string,
): BureauAgentInstance<WideRollupRecord, { rollup: WideRollupRecord }> {
  return {
    name: "triage-analyze",
    args: { rollup },
    definition: triageAnalyze(),
    context: buildTriageAnalyzeContext(cwd),
    buildInput() {
      return rollup;
    },
  };
}
