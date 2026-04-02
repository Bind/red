import type { ManualClawJob } from "../types";
import { loadPromptTemplate, renderPrompt } from "../prompts";

export interface SummarizeAndPatchJson {
  title: string;
  summary: string;
  patch_summary: string;
  recommended_action: "approve" | "review" | "block";
}

interface SummarizeAndPatchInput {
  repo: string;
  headRef: string;
  baseRef: string;
}

export const summarizeAndPatchJob: ManualClawJob<
  SummarizeAndPatchInput,
  SummarizeAndPatchJson
> = {
  name: "summarize-and-patch",
  description: "Summarize a change and produce a proposed patch artifact.",
  parseCliArgs(args) {
    const values = parseArgs(args);
    return {
      repo: required(values, "repo"),
      headRef: required(values, "head"),
      baseRef: values.base ?? "main",
    };
  },
  build(input) {
    return {
      repo: input.repo,
      headRef: input.headRef,
      baseRef: input.baseRef,
      output: { json: true, files: ["patch.diff"] },
      metadata: { jobName: "summarize-and-patch" },
      instructions: renderPrompt(loadPromptTemplate("summarize-and-patch"), {
        baseRef: input.baseRef,
      }),
      parseJson: validateSummarizeAndPatchJson,
    };
  },
};

function validateSummarizeAndPatchJson(raw: unknown): SummarizeAndPatchJson {
  if (!raw || typeof raw !== "object") {
    throw new Error("Patch summary JSON is not an object");
  }

  const summary = raw as Record<string, unknown>;
  if (
    typeof summary.title !== "string" ||
    typeof summary.summary !== "string" ||
    typeof summary.patch_summary !== "string" ||
    typeof summary.recommended_action !== "string"
  ) {
    throw new Error("Patch summary JSON is missing required fields");
  }

  if (!["approve", "review", "block"].includes(summary.recommended_action)) {
    throw new Error("recommended_action must be approve, review, or block");
  }

  return {
    title: summary.title,
    summary: summary.summary,
    patch_summary: summary.patch_summary,
    recommended_action: summary.recommended_action as SummarizeAndPatchJson["recommended_action"],
  };
}

function parseArgs(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    values[key] = value;
    i++;
  }
  return values;
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}
