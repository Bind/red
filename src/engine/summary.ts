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

export interface CodexRunnerConfig {
  /** Docker image name for the codex runner. */
  image: string;
  /** Base URL for git clone (e.g. http://user:pass@localhost:3001). Repo path is appended. */
  forgejoBaseUrl: string;
  /** OpenAI API key passed into the container. */
  openaiApiKey: string;
  /** Timeout in ms. Default: 120000 (2 min). */
  timeout?: number;
}

/**
 * Runs Codex as an agent inside a Docker container with the full codebase.
 * Codex can read files, trace imports, and understand context — not just a flat diff.
 */
export class CodexSummaryGenerator implements SummaryGenerator {
  private config: CodexRunnerConfig;

  constructor(config: CodexRunnerConfig) {
    this.config = config;
  }

  async generate(params: SummaryInput): Promise<LLMSummary> {
    const { repo, branch, diffStats, confidence, commitMessages } = params;
    const repoUrl = `${this.config.forgejoBaseUrl.replace(/\/+$/, "")}/${repo}.git`;

    const prompt = [
      `You are reviewing a change on branch "${branch}" in repo "${repo}".`,
      `Run: git diff origin/main...HEAD to see what changed.`,
      `Read the changed files to understand the full context.`,
      ``,
      `Stats: ${diffStats.files_changed} files, +${diffStats.additions}/-${diffStats.deletions}`,
      `Scoring confidence: ${confidence}`,
      commitMessages.length > 0 ? `Commits: ${commitMessages.join("; ")}` : "",
      ``,
      `After analyzing the code, respond with ONLY a JSON object:`,
      `{`,
      `  "title": "short PR title, imperative mood, under 60 chars",`,
      `  "what_changed": "1-2 sentence description of the functional change",`,
      `  "risk_assessment": "1-2 sentence risk analysis with specific concerns",`,
      `  "affected_modules": ["top/level", "directory/paths"],`,
      `  "recommended_action": "approve" | "review" | "block"`,
      `}`,
    ].filter(Boolean).join("\n");

    const timeout = this.config.timeout ?? 120_000;

    const proc = Bun.spawn([
      "docker", "run", "--rm",
      "-e", `REPO_URL=${repoUrl}`,
      "-e", `BASE_REF=main`,
      "-e", `HEAD_SHA=${branch}`,
      "-e", `CODEX_PROMPT=${prompt}`,
      "-e", `OPENAI_API_KEY=${this.config.openaiApiKey}`,
      this.config.image,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (exitCode !== 0) {
      throw new Error(`Codex runner exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    // Extract JSON from stdout
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Codex runner produced no JSON. stdout: ${stdout.slice(0, 500)}`);
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
