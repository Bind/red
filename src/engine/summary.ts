import { Codex } from "@openai/codex-sdk";
import type { DiffStats, LLMSummary, ConfidenceLevel } from "../types";

/**
 * Summary generator interface — allows swapping in a real LLM backend later.
 */
export interface SummaryGenerator {
  generate(params: SummaryInput): Promise<LLMSummary>;
}

export interface SummaryInput {
  repo: string;
  branch: string;
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

    return {
      title: `${params.branch}: ${diffStats.files_changed} files changed`,
      what_changed: what,
      risk_assessment: risk,
      affected_modules: modules,
      recommended_action: action,
    };
  }
}

const SUMMARY_SCHEMA = {
  type: "object" as const,
  properties: {
    title: { type: "string" as const, description: "Short PR title, imperative mood, under 60 chars" },
    what_changed: { type: "string" as const, description: "1-2 sentence description of the functional change" },
    risk_assessment: { type: "string" as const, description: "1-2 sentence risk analysis noting specific concerns or confirming safety" },
    affected_modules: { type: "array" as const, items: { type: "string" as const }, description: "Top-level directory paths affected" },
    recommended_action: { type: "string" as const, enum: ["approve", "review", "block"] },
  },
  required: ["title", "what_changed", "risk_assessment", "affected_modules", "recommended_action"],
  additionalProperties: false as const,
};

/**
 * LLM-backed summary generator using the Codex SDK.
 * Uses your existing OpenAI subscription — no separate API key needed.
 */
export class CodexSummaryGenerator implements SummaryGenerator {
  private codex: Codex;

  constructor() {
    this.codex = new Codex();
  }

  async generate(params: SummaryInput): Promise<LLMSummary> {
    const { repo, branch, diff, diffStats, confidence, commitMessages } = params;

    const truncatedDiff = diff.length > 12000
      ? diff.slice(0, 12000) + "\n... (truncated)"
      : diff;

    const prompt = `You are a code review assistant. Analyze this diff and produce a structured summary.

Repository: ${repo}
Branch: ${branch}
Confidence: ${confidence}
Stats: ${diffStats.files_changed} files, +${diffStats.additions}/-${diffStats.deletions}
${commitMessages.length > 0 ? `Commits: ${commitMessages.join("; ")}` : ""}

Diff:
\`\`\`
${truncatedDiff}
\`\`\``;

    const thread = this.codex.startThread({ skipGitRepoCheck: true });
    const turn = await thread.run(prompt, { outputSchema: SUMMARY_SCHEMA });

    // Extract text from the final response
    const text = turn.finalResponse ?? "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Codex response did not contain valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]) as LLMSummary;

    if (!parsed.title || !parsed.what_changed || !parsed.risk_assessment || !parsed.recommended_action) {
      throw new Error("Codex response missing required fields");
    }

    return parsed;
  }
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
