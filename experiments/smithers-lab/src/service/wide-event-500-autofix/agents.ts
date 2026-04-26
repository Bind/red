import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent } from "ai";

export function createWideEventClassifierAgent(model: string): ToolLoopAgent {
  return new ToolLoopAgent({
    model: openai(model),
    instructions:
      "You classify recurring 500 errors for a production engineering system. Be concrete, conservative, and avoid claiming patchability without evidence.",
  });
}

export function createWideEventEvidenceAgent(model: string): ToolLoopAgent {
  return new ToolLoopAgent({
    model: openai(model),
    instructions:
      "You summarize operational evidence from a request failure. Focus on request root status, rollup behavior, likely owner, and patchability signals.",
  });
}

export function createWideEventContextAgent(model: string): ToolLoopAgent {
  return new ToolLoopAgent({
    model: openai(model),
    instructions:
      "You map incidents to repo, branch, and ownership context in red. Prefer explicit ownership and call out ambiguity.",
  });
}

export function createWideEventAggregatorAgent(model: string): ToolLoopAgent {
  return new ToolLoopAgent({
    model: openai(model),
    instructions:
      "You aggregate incident classification, evidence, and ownership into a diagnosis-first remediation plan. Default to diagnose-only when confidence is limited.",
  });
}
