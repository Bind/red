import type { LLMSummary } from "../../types";
import type { SummaryInput } from "../../engine/summary";
import { buildSummaryPrompt, validateSummaryOutput } from "../../engine/tasks/summary";
import type { ClawJobDefinition } from "../types";

export const generateSummaryJob: ClawJobDefinition<SummaryInput, LLMSummary> = {
  name: "generate-summary",
  description: "Generate the product summary JSON for a reviewed change.",
  build(input) {
    const prompt = [
      buildSummaryPrompt(input),
      "",
      "Use the unified diff below as the primary source of truth.",
      "Return exactly one JSON object and nothing else.",
      "",
      "## Unified diff",
      input.diff,
    ].join("\n");

    return {
      repo: input.repo,
      headRef: input.headRef,
      baseRef: input.baseRef,
      output: { json: true },
      metadata: {
        jobName: "generate-summary",
        jobId: input.jobId != null ? String(input.jobId) : undefined,
        changeId: input.changeId,
      },
      instructions: prompt,
      parseJson: validateSummaryOutput,
    };
  },
};
