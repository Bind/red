import { parse as parseYaml } from "yaml";
import type { PolicyConfig, ConfidenceLevel, DiffStats } from "../types";
import type { RepoProvider } from "../repo/provider";
import { matchGlob } from "./review";
import {
  ruleMatches,
  actionPriority,
  validatePolicy,
} from "./policy-shared";
import type { PolicyRule } from "../types";

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
  constructor(private repoProvider: RepoProvider) {}

  /**
   * Load policy from the repo's base branch.
   * Returns null if no policy file exists (repo hasn't configured redc).
   */
  async loadPolicy(
    owner: string,
    repo: string,
    baseBranch: string
  ): Promise<PolicyConfig | null> {
    const content = await this.repoProvider.getFileContent(
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
