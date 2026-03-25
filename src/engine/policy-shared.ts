import type { PolicyConfig, PolicyRule, ConfidenceLevel, DiffStats } from "../types";
import { matchGlob } from "./review";

/**
 * Shared policy validation and rule matching used by both
 * engine/policy.ts (server-side) and cli/policy.ts (dry-run CLI).
 */

/** Check if a policy rule matches the given diff and confidence. */
export function ruleMatches(
  rule: PolicyRule,
  diff: DiffStats,
  confidence: ConfidenceLevel
): boolean {
  if (rule.match.confidence && rule.match.confidence !== confidence) {
    return false;
  }
  if (rule.match.files && rule.match.files.length > 0) {
    const hasFileMatch = diff.files.some((f) =>
      rule.match.files!.some((pattern) => matchGlob(pattern, f.filename))
    );
    if (!hasFileMatch) return false;
  }
  return true;
}

/** Priority ordering: block > require-review > auto-approve */
export function actionPriority(action: string): number {
  switch (action) {
    case "auto-approve": return 0;
    case "require-review": return 1;
    case "block": return 2;
    default: return 1;
  }
}

/** Validate a ConfidenceLevel string. */
export function validConfidence(val: unknown): ConfidenceLevel | undefined {
  if (val === "safe" || val === "needs_review" || val === "critical") return val;
  return undefined;
}

/** Validate a PolicyRule action string. */
export function validAction(val: unknown): PolicyRule["action"] {
  if (val === "auto-approve" || val === "require-review" || val === "block") return val;
  return "require-review";
}

/**
 * Validate and normalize a parsed YAML policy object.
 * Lenient: ignores unknown fields, provides defaults.
 */
export function validatePolicy(raw: unknown): PolicyConfig {
  if (!raw || typeof raw !== "object") {
    return { rules: [] };
  }

  const obj = raw as Record<string, unknown>;
  const rawRules = Array.isArray(obj.rules) ? obj.rules : [];

  const rules: PolicyRule[] = rawRules
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map((r) => ({
      name: String(r.name ?? "unnamed"),
      match: {
        files: Array.isArray((r.match as any)?.files)
          ? (r.match as any).files.map(String)
          : undefined,
        confidence: validConfidence((r.match as any)?.confidence),
      },
      action: validAction(r.action),
      reviewers: Array.isArray(r.reviewers) ? r.reviewers.map(String) : undefined,
    }));

  return { rules };
}
