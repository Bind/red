import type { ManualClawJob } from "../types";
import { loadPromptTemplate, renderPrompt } from "../prompts";

export interface ReviewReportJson {
  title: string;
  recommendation: "approve" | "review" | "block";
}

interface WriteReviewReportInput {
  repo: string;
  headRef: string;
  baseRef: string;
}

export const writeReviewReportJob: ManualClawJob<WriteReviewReportInput, ReviewReportJson> = {
  name: "write-review-report",
  description: "Produce a small JSON decision plus a Markdown report artifact.",
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
      output: { json: true, files: ["report.md"] },
      metadata: { jobName: "write-review-report" },
      instructions: renderPrompt(loadPromptTemplate("write-review-report"), {
        baseRef: input.baseRef,
      }),
      parseJson: validateReviewReportJson,
    };
  },
};

function validateReviewReportJson(raw: unknown): ReviewReportJson {
  if (!raw || typeof raw !== "object") {
    throw new Error("Report JSON is not an object");
  }

  const report = raw as Record<string, unknown>;
  if (typeof report.title !== "string" || typeof report.recommendation !== "string") {
    throw new Error("Report JSON is missing required fields");
  }

  if (!["approve", "review", "block"].includes(report.recommendation)) {
    throw new Error("recommendation must be approve, review, or block");
  }

  return {
    title: report.title,
    recommendation: report.recommendation as ReviewReportJson["recommendation"],
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
