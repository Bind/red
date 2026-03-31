import type { DiffStats, LLMSummary, ConfidenceLevel, SummaryAnnotation } from "../types";
import type { RepoTaskRunner } from "./runner";
import { buildSummaryPrompt, validateSummaryOutput } from "./tasks/summary";

/**
 * Summary generator interface — allows swapping in a real LLM backend later.
 */
export interface SummaryGenerator {
  generate(params: SummaryInput, onLog?: (line: string) => void): Promise<LLMSummary>;
}

export interface SummaryInput {
  repo: string;
  branch: string;
  baseRef: string;
  headRef: string;
  diff: string;
  diffStats: DiffStats;
  confidence: ConfidenceLevel;
  commitMessages: string[];
}

/**
 * V1 stub: generates structured summaries from diff stats and commit messages.
 * No LLM call — deterministic output from heuristics.
 * Swap this for a real LLM-backed implementation in Phase 3.
 */
export class StubSummaryGenerator implements SummaryGenerator {
  async generate(params: SummaryInput): Promise<LLMSummary> {
    const { diffStats, confidence, commitMessages } = params;

    const totalLines = diffStats.additions + diffStats.deletions;
    const fileList = diffStats.files.map((f) => f.filename);
    const modules = extractModules(fileList);

    const what = commitMessages.length > 0
      ? commitMessages.join("; ")
      : `${diffStats.files_changed} files changed (+${diffStats.additions}/-${diffStats.deletions})`;

    const risk = buildRiskAssessment(diffStats, confidence);
    const action = mapConfidenceToAction(confidence);
    const annotations = buildStubAnnotations(diffStats);

    return {
      title: `${params.branch}: ${diffStats.files_changed} files changed`,
      what_changed: what,
      risk_assessment: risk,
      affected_modules: modules,
      recommended_action: action,
      annotations,
    };
  }
}

/**
 * Runs Codex as an agent inside a Docker container with the full codebase.
 * Delegates Docker lifecycle to RepoTaskRunner; handles prompt building and output validation.
 */
export class CodexSummaryGenerator implements SummaryGenerator {
  constructor(private runner: RepoTaskRunner) {}

  async generate(params: SummaryInput, onLog?: (line: string) => void): Promise<LLMSummary> {
    const prompt = buildSummaryPrompt(params);

    const result = await this.runner.run({
      repo: params.repo,
      baseRef: params.baseRef,
      headRef: params.headRef,
      prompt,
      onLog,
    });

    if (!result.ok) {
      throw new Error(`Codex runner failed (${result.durationMs}ms): ${result.logs.slice(0, 500)}`);
    }

    return validateSummaryOutput(result.output);
  }
}

/**
 * Build annotations from diff stats by grouping files by status.
 */
function buildStubAnnotations(diffStats: DiffStats): SummaryAnnotation[] {
  const groups: Record<string, { type: SummaryAnnotation["type"]; files: string[] }> = {};

  for (const f of diffStats.files) {
    let type: SummaryAnnotation["type"];
    let label: string;
    switch (f.status) {
      case "added":
        type = "new_module";
        label = "added";
        break;
      case "deleted":
        type = "refactor";
        label = "deleted";
        break;
      default:
        type = "change";
        label = "modified";
        break;
    }
    if (!groups[label]) groups[label] = { type, files: [] };
    groups[label].files.push(f.filename);
  }

  const annotations: SummaryAnnotation[] = [];
  for (const [label, { type, files }] of Object.entries(groups)) {
    annotations.push({
      text: `${files.length} file(s) ${label}`,
      files,
      type,
    });
  }
  return annotations;
}

/**
 * Extract top-level directory modules from file paths.
 * e.g. ["src/api/webhooks.ts", "src/db/schema.ts"] → ["src/api", "src/db"]
 */
function extractModules(files: string[]): string[] {
  const modules = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length >= 2) {
      modules.add(parts.slice(0, 2).join("/"));
    } else {
      modules.add(parts[0]);
    }
  }
  return [...modules].sort();
}

function buildRiskAssessment(diff: DiffStats, confidence: ConfidenceLevel): string {
  const totalLines = diff.additions + diff.deletions;
  const parts: string[] = [];

  if (confidence === "critical") {
    parts.push("High-risk change.");
  } else if (confidence === "needs_review") {
    parts.push("Moderate-risk change.");
  } else {
    parts.push("Low-risk change.");
  }

  parts.push(`${totalLines} lines across ${diff.files_changed} files.`);

  const deletionRatio = diff.deletions / (totalLines || 1);
  if (deletionRatio > 0.7) {
    parts.push("Primarily deletions — verify nothing critical was removed.");
  }

  const addedFiles = diff.files.filter((f) => f.status === "added");
  if (addedFiles.length > 0) {
    parts.push(`${addedFiles.length} new file(s) added.`);
  }

  return parts.join(" ");
}

function mapConfidenceToAction(confidence: ConfidenceLevel): LLMSummary["recommended_action"] {
  switch (confidence) {
    case "safe": return "approve";
    case "needs_review": return "review";
    case "critical": return "block";
  }
}
