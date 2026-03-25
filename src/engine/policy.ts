import { parse as parseYaml } from "yaml";
import type { PolicyConfig, PolicyRule, ConfidenceLevel, DiffStats } from "../types";
import type { ForgejoClient } from "../forgejo/client";
import { matchGlob } from "./review";

export interface PolicyDecision {
  action: "auto-approve" | "require-review" | "block";
  matchedRules: Array<{ rule: string; reason: string }>;
}

/**
 * Policy engine — reads .redc/policy.yaml from the base branch and evaluates
 * rules against a change's diff stats and confidence level.
 *
 * Policy is always pinned to the base branch (never the PR branch) to prevent
 * PRs from modifying their own review policy.
 */
export class PolicyEngine {
  constructor(private forgejo: ForgejoClient) {}

  /**
   * Load policy from the repo's base branch.
   * Returns null if no policy file exists (repo hasn't configured redc).
   */
  async loadPolicy(
    owner: string,
    repo: string,
    baseBranch: string
  ): Promise<PolicyConfig | null> {
    const content = await this.forgejo.getFileContent(
      owner,
      repo,
      ".redc/policy.yaml",
      baseBranch
    );

    if (!content) return null;

    const parsed = parseYaml(content);
    return validatePolicy(parsed);
  }

  /**
   * Evaluate policy rules against a change.
   * Rules are evaluated in order; first match wins per action category.
   * If no policy exists, defaults to require-review (suggest-approve default).
   */
  evaluate(
    policy: PolicyConfig | null,
    diff: DiffStats,
    confidence: ConfidenceLevel
  ): PolicyDecision {
    // No policy = default to require-review
    if (!policy || policy.rules.length === 0) {
      return {
        action: "require-review",
        matchedRules: [{ rule: "default", reason: "No policy configured" }],
      };
    }

    const matched: PolicyDecision["matchedRules"] = [];
    let finalAction: PolicyDecision["action"] = "auto-approve";

    for (const rule of policy.rules) {
      if (ruleMatches(rule, diff, confidence)) {
        matched.push({ rule: rule.name, reason: describeMatch(rule, diff, confidence) });

        // Escalate action: block > require-review > auto-approve
        if (actionPriority(rule.action) > actionPriority(finalAction)) {
          finalAction = rule.action;
        }
      }
    }

    // If no rules matched, default to require-review
    if (matched.length === 0) {
      return {
        action: "require-review",
        matchedRules: [{ rule: "default", reason: "No matching rules" }],
      };
    }

    return { action: finalAction, matchedRules: matched };
  }
}

function ruleMatches(
  rule: PolicyRule,
  diff: DiffStats,
  confidence: ConfidenceLevel
): boolean {
  // Check confidence match
  if (rule.match.confidence && rule.match.confidence !== confidence) {
    return false;
  }

  // Check file pattern match
  if (rule.match.files && rule.match.files.length > 0) {
    const hasFileMatch = diff.files.some((f) =>
      rule.match.files!.some((pattern) => matchGlob(pattern, f.filename))
    );
    if (!hasFileMatch) return false;
  }

  return true;
}

function describeMatch(
  rule: PolicyRule,
  diff: DiffStats,
  confidence: ConfidenceLevel
): string {
  const parts: string[] = [];
  if (rule.match.confidence) {
    parts.push(`confidence=${confidence}`);
  }
  if (rule.match.files) {
    const matched = diff.files
      .filter((f) => rule.match.files!.some((p) => matchGlob(p, f.filename)))
      .map((f) => f.filename);
    if (matched.length > 0) {
      parts.push(`files=${matched.join(",")}`);
    }
  }
  return parts.join("; ") || "unconditional match";
}

function actionPriority(action: PolicyDecision["action"]): number {
  switch (action) {
    case "auto-approve": return 0;
    case "require-review": return 1;
    case "block": return 2;
  }
}

/**
 * Validate and normalize a parsed YAML policy object.
 * Lenient: ignores unknown fields, provides defaults.
 */
function validatePolicy(raw: unknown): PolicyConfig {
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

function validConfidence(val: unknown): ConfidenceLevel | undefined {
  if (val === "safe" || val === "needs_review" || val === "critical") return val;
  return undefined;
}

function validAction(val: unknown): PolicyRule["action"] {
  if (val === "auto-approve" || val === "require-review" || val === "block") return val;
  return "require-review"; // safe default
}
