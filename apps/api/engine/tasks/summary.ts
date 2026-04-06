import type { LLMSummary, SummaryAnnotation } from "../../types";
import type { SummaryInput } from "../summary";

/**
 * Build the prompt string for Codex to generate a change summary.
 * Uses baseRef so it works for repos where the default branch isn't "main".
 */
export function buildSummaryPrompt(params: SummaryInput): string {
  const { repo, branch, baseRef, diffStats, confidence, commitMessages } = params;

  return [
    `You are reviewing a change on branch "${branch}" in repo "${repo}".`,
    `Run: git diff origin/${baseRef}...HEAD to see what changed.`,
    `Read the changed files to understand the full context.`,
    ``,
    `Stats: ${diffStats.files_changed} files, +${diffStats.additions}/-${diffStats.deletions}`,
    `Scoring confidence: ${confidence}`,
    commitMessages.length > 0 ? `Commits: ${commitMessages.join("; ")}` : "",
    ``,
    `After analyzing the code, respond with ONLY a JSON object:`,
    `{`,
    `  "title": "short PR title, imperative mood, under 60 chars",`,
    `  "what_changed": "Multi-sentence summary. Each sentence should describe a distinct aspect: new modules/architecture, refactoring/renames, bug fixes, config/infra changes.",`,
    `  "risk_assessment": "1-2 sentence risk analysis with specific concerns",`,
    `  "affected_modules": ["top/level", "directory/paths"],`,
    `  "recommended_action": "approve" | "review" | "block",`,
    `  "annotations": [`,
    `    { "text": "exact sentence from what_changed", "files": ["path/to/file.ts"], "type": "new_module|refactor|bugfix|config|change" }`,
    `  ]`,
    `}`,
    ``,
    `You MUST finish by calling the custom "done" tool with the final summary fields.`,
    `Do not stop after printing JSON in plain text.`,
    `Do not consider the task complete until the "done" tool has been called successfully.`,
    `If you are still analyzing, continue working; only call "done" once the final summary is ready.`,
    ``,
    `The "annotations" array maps each sentence in "what_changed" to the files it describes.`,
    `Each annotation "text" must be an exact sentence from "what_changed".`,
    `"type" categorizes the change: "new_module" for new files/architecture, "refactor" for renames/restructuring, "bugfix" for fixes, "config" for config/infra, "change" for general modifications.`,
  ].filter(Boolean).join("\n");
}

/**
 * Validate and type-narrow the raw JSON output from Codex into an LLMSummary.
 * Throws if required fields are missing.
 */
export function validateSummaryOutput(raw: unknown): LLMSummary {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Summary output is not an object");
  }

  const obj = raw as Record<string, unknown>;

  if (!obj.title || !obj.what_changed || !obj.risk_assessment || !obj.recommended_action) {
    throw new Error("Summary output missing required fields");
  }

  // Validate annotations if present, but don't require them
  if (Array.isArray(obj.annotations)) {
    obj.annotations = (obj.annotations as unknown[]).filter((a): a is SummaryAnnotation => {
      if (typeof a !== "object" || a === null) return false;
      const ann = a as Record<string, unknown>;
      return typeof ann.text === "string" && Array.isArray(ann.files) && typeof ann.type === "string";
    });
  }

  return obj as unknown as LLMSummary;
}
