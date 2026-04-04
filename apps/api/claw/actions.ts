import { createHash } from "node:crypto";
import type { ClawJobDefinition, ManualClawJob } from "./types";
import { summarizeChangeJob } from "./jobs/summarize-change";
import { writeReviewReportJob } from "./jobs/write-review-report";
import { summarizeAndPatchJob } from "./jobs/summarize-and-patch";
import { generateSummaryJob } from "./jobs/generate-summary";
import { getPromptPath, loadPromptTemplate } from "./prompts";

export const manualClawActions = [
  summarizeChangeJob,
  writeReviewReportJob,
  summarizeAndPatchJob,
] as const satisfies readonly ManualClawJob<unknown, unknown>[];

export const manualClawActionMap = new Map(
  manualClawActions.map((job) => [job.name, job as ManualClawJob<unknown, unknown>])
);

export const productClawActions = {
  generateSummary: generateSummaryJob,
} as const satisfies Record<string, ClawJobDefinition<unknown, unknown>>;

export const clawPromptRegistry = {
  "summarize-change": "summarize-change",
  "write-review-report": "write-review-report",
  "summarize-and-patch": "summarize-and-patch",
  "generate-summary": "generate-summary",
} as const;

export interface ClawActionMetadata {
  id: string;
  description: string;
  promptName: string;
  promptPath: string;
  promptHash: string;
  surfaces: Array<"manual" | "product">;
}

export interface ClawActionPrompt extends ClawActionMetadata {
  prompt: string;
}

export function listClawActions(): ClawActionMetadata[] {
  const manualIds = new Set(manualClawActions.map((job) => job.name));
  const productIds = new Set(Object.values(productClawActions).map((job) => job.name));
  const ids = [...new Set([...manualIds, ...productIds])];

  return ids
    .map((id) => getClawActionMetadata(id))
    .filter((action): action is ClawActionMetadata => action !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getClawActionMetadata(id: string): ClawActionMetadata | null {
  const manualJob = manualClawActionMap.get(id);
  const productJob = Object.values(productClawActions).find((job) => job.name === id);
  const job = manualJob ?? productJob;
  const promptName = clawPromptRegistry[id as keyof typeof clawPromptRegistry];

  if (!job || !promptName) return null;

  const prompt = loadPromptTemplate(promptName);
  const surfaces: Array<"manual" | "product"> = [];
  if (manualJob) surfaces.push("manual");
  if (productJob) surfaces.push("product");

  return {
    id,
    description: job.description,
    promptName,
    promptPath: getPromptPath(promptName),
    promptHash: hashPrompt(prompt),
    surfaces,
  };
}

export function getClawActionPrompt(id: string): ClawActionPrompt | null {
  const metadata = getClawActionMetadata(id);
  if (!metadata) return null;

  return {
    ...metadata,
    prompt: loadPromptTemplate(metadata.promptName),
  };
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
