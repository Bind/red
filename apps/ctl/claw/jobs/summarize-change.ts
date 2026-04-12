import type { ManualClawJob } from "../types";
import { loadPromptTemplate, renderPrompt } from "../prompts";

export interface ChangeSummary {
  title: string;
  summary: string;
  risk_assessment: string;
  affected_modules: string[];
  recommended_action: "approve" | "review" | "block";
}

interface SummarizeChangeInput {
  repo: string;
  headRef: string;
  baseRef: string;
}

export const summarizeChangeJob: ManualClawJob<SummarizeChangeInput, ChangeSummary> = {
  name: "summarize-change",
  description: "Inspect a change and write a structured JSON summary to .claw-output/result.json.",
  parseCliArgs(args) {
    const values = parseArgs(args);
    const repo = required(values, "repo");
    const headRef = required(values, "head");
    const baseRef = values.base ?? "main";
    return { repo, headRef, baseRef };
  },
  build(input) {
    return {
      repo: input.repo,
      headRef: input.headRef,
      baseRef: input.baseRef,
      output: { json: true },
      metadata: { jobName: "summarize-change" },
      instructions: renderPrompt(loadPromptTemplate("summarize-change"), {
        baseRef: input.baseRef,
      }),
      parseJson: validateChangeSummary,
    };
  },
};

function validateChangeSummary(raw: unknown): ChangeSummary {
  if (!raw || typeof raw !== "object") {
    throw new Error("Summary is not an object");
  }

  const summary = raw as Record<string, unknown>;

  if (
    typeof summary.title !== "string" ||
    typeof summary.summary !== "string" ||
    typeof summary.risk_assessment !== "string" ||
    !Array.isArray(summary.affected_modules) ||
    typeof summary.recommended_action !== "string"
  ) {
    throw new Error("Summary is missing required fields");
  }

  if (!["approve", "review", "block"].includes(summary.recommended_action)) {
    throw new Error("recommended_action must be approve, review, or block");
  }

  return {
    title: summary.title,
    summary: summary.summary,
    risk_assessment: summary.risk_assessment,
    affected_modules: summary.affected_modules.map(String),
    recommended_action: summary.recommended_action as ChangeSummary["recommended_action"],
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
