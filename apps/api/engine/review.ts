import type { ConfidenceLevel, DiffStats } from "../types";

export interface ScoringResult {
  confidence: ConfidenceLevel;
  reasons: string[];
}

export interface ScoringConfig {
  /** Max total lines changed for "safe" classification. Default: 50 */
  safeLinesThreshold: number;
  /** Max files changed for "safe" classification. Default: 5 */
  safeFilesThreshold: number;
  /** Lines changed above this = "critical". Default: 500 */
  criticalLinesThreshold: number;
  /** Files changed above this = "critical". Default: 20 */
  criticalFilesThreshold: number;
  /** File patterns that always trigger "needs_review" or higher. */
  sensitivePatterns: string[];
}

const DEFAULT_CONFIG: ScoringConfig = {
  safeLinesThreshold: 50,
  safeFilesThreshold: 5,
  criticalLinesThreshold: 500,
  criticalFilesThreshold: 20,
  sensitivePatterns: [
    "*.lock",
    "*.toml",
    "Dockerfile*",
    "docker-compose*",
    ".github/**",
    ".forgejo/**",
    "*.sql",
    "*migration*",
    "*.env*",
    "*.secret*",
    "*.key",
    "*.pem",
  ],
};

/**
 * Heuristic confidence scorer for changes.
 * V1: pure diff-stats based, no LLM. Intentionally conservative —
 * defaults to needs_review when uncertain.
 */
export class ScoringEngine {
  private config: ScoringConfig;

  constructor(config: Partial<ScoringConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  score(diff: DiffStats): ScoringResult {
    const reasons: string[] = [];
    let level: ConfidenceLevel = "safe";

    const totalLines = diff.additions + diff.deletions;

    // Check for critical thresholds
    if (totalLines > this.config.criticalLinesThreshold) {
      level = "critical";
      reasons.push(`${totalLines} lines changed (threshold: ${this.config.criticalLinesThreshold})`);
    }

    if (diff.files_changed > this.config.criticalFilesThreshold) {
      level = "critical";
      reasons.push(`${diff.files_changed} files changed (threshold: ${this.config.criticalFilesThreshold})`);
    }

    // Check for sensitive file patterns
    const sensitiveFiles = diff.files.filter((f) =>
      this.config.sensitivePatterns.some((p) => matchGlob(p, f.filename))
    );
    if (sensitiveFiles.length > 0) {
      if (level !== "critical") level = "needs_review";
      reasons.push(
        `Sensitive files: ${sensitiveFiles.map((f) => f.filename).join(", ")}`
      );
    }

    // Check for deletions-heavy changes (more deletions than additions)
    if (diff.deletions > diff.additions && diff.deletions > 20) {
      if (level === "safe") level = "needs_review";
      reasons.push(`Deletion-heavy: ${diff.deletions} deletions vs ${diff.additions} additions`);
    }

    // If still safe, check against safe thresholds
    if (level === "safe") {
      if (totalLines > this.config.safeLinesThreshold) {
        level = "needs_review";
        reasons.push(`${totalLines} lines changed (safe threshold: ${this.config.safeLinesThreshold})`);
      }
      if (diff.files_changed > this.config.safeFilesThreshold) {
        level = "needs_review";
        reasons.push(`${diff.files_changed} files changed (safe threshold: ${this.config.safeFilesThreshold})`);
      }
    }

    if (reasons.length === 0) {
      reasons.push(`Small change: ${totalLines} lines across ${diff.files_changed} files`);
    }

    return { confidence: level, reasons };
  }
}

/**
 * Simple glob matcher supporting * and ** patterns.
 * Not a full glob implementation — covers the common cases.
 */
export function matchGlob(pattern: string, filepath: string): boolean {
  // Split on ** and * first, then escape each literal segment
  const parts: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      parts.push(".*");
      i += 2;
    } else if (pattern[i] === "*") {
      parts.push("[^/]*");
      i += 1;
    } else {
      // Collect literal chars until next *
      let literal = "";
      while (i < pattern.length && pattern[i] !== "*") {
        literal += pattern[i];
        i++;
      }
      // Escape regex-special chars in the literal
      parts.push(literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
  const regex = parts.join("");
  return new RegExp(`^${regex}$`).test(filepath) ||
    new RegExp(`(^|/)${regex}$`).test(filepath);
}
