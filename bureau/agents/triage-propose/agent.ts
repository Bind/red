import { join, resolve } from "node:path";
import { agent, type BureauAgentContext, type BureauAgentInstance } from "../../sdk";
import type { TriagePlan } from "../triage-analyze/agent";

export type TriageProposeInput = {
  plan: TriagePlan;
};

export type TriageProposal = {
  repoId: string;
  branch: string;
  summary: string;
  prUrl?: string;
};

const TRIAGE_PROPOSE_INSTRUCTIONS = [
  "You are a triage agent.",
  "An approved plan is provided describing the suspected root cause and proposed change.",
  "Implement the proposed change in the workspace, then summarize what you did.",
  "Call complete exactly once with a structured TriageProposal containing the target",
  "repo id, branch, and human-readable summary.",
].join(" ");

export function triagePropose() {
  return agent<TriageProposeInput>()
    .instructions(TRIAGE_PROPOSE_INSTRUCTIONS)
    .initialInput((ctx) => describePlan(ctx.input.plan))
    .build();
}

function describePlan(plan: TriagePlan): string {
  return [
    `Approved plan (confidence: ${plan.confidence}):`,
    `Hypothesis: ${plan.hypothesis}`,
    `Proposed change: ${plan.proposedChangeSummary}`,
    `Suspected files:\n${plan.suspectedFiles.map((f) => `  - ${f}`).join("\n") || "  (none listed)"}`,
    `Reproduction steps:\n${plan.reproductionSteps.map((s) => `  - ${s}`).join("\n") || "  (none listed)"}`,
  ].join("\n\n");
}

export function buildTriageProposeContext(
  cwd: string,
): Omit<BureauAgentContext<TriageProposeInput>, "sessionId" | "input"> {
  const root = resolve(cwd);
  const agentDir = join(root, "bureau", "agents", "triage-propose");
  return {
    name: "triage-propose",
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

export function createTriageProposeAgentInstance(
  input: TriageProposeInput,
  cwd: string,
): BureauAgentInstance<TriageProposeInput, TriageProposeInput> {
  return {
    name: "triage-propose",
    args: input,
    definition: triagePropose(),
    context: buildTriageProposeContext(cwd),
    buildInput() {
      return input;
    },
  };
}
