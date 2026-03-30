import Anthropic from "@anthropic-ai/sdk";
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

/**
 * LLM-backed summary generator using Claude.
 */
export class ClaudeSummaryGenerator implements SummaryGenerator {
  private client: Anthropic;
  private model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-4-5-20250929";
  }

  async generate(params: SummaryInput): Promise<LLMSummary> {
    const { repo, branch, diff, diffStats, confidence, commitMessages } = params;

    // Truncate diff to ~12k chars to stay within token limits
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
\`\`\`

Respond with ONLY valid JSON matching this exact schema:
{
  "title": "short PR title, imperative mood, under 60 chars",
  "what_changed": "1-2 sentence description of the functional change",
  "risk_assessment": "1-2 sentence risk analysis noting specific concerns or confirming safety",
  "affected_modules": ["top/level", "directory/paths"],
  "recommended_action": "approve" | "review" | "block"
}`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("LLM response did not contain valid JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]) as LLMSummary;

    // Validate required fields
    if (!parsed.title || !parsed.what_changed || !parsed.risk_assessment || !parsed.recommended_action) {
      throw new Error("LLM response missing required fields");
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
