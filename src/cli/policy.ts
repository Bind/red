import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CliContext } from "./index";
import type { PolicyConfig, DiffStats, ConfidenceLevel } from "../types";

export async function policyTestCommand(ctx: CliContext): Promise<number> {
  // Find policy file
  const policyPath = ctx.args[2] ?? resolve(".redc/policy.yaml");

  let rawYaml: string;
  try {
    rawYaml = readFileSync(policyPath, "utf-8");
  } catch {
    console.error(`Error: could not read policy file at ${policyPath}`);
    console.error("Create .redc/policy.yaml or pass a path: redc policy test <path>");
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    console.error(`Error: invalid YAML in ${policyPath}`);
    console.error(`  ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  const policy = validatePolicy(parsed);

  if (ctx.format === "json") {
    const results = TEST_SCENARIOS.map((s) => ({
      scenario: s.name,
      ...evaluateScenario(policy, s),
    }));
    console.log(JSON.stringify({ policy_file: policyPath, rules: policy.rules.length, results }, null, 2));
    return 0;
  }

  // Text output
  console.log(`Policy: ${policyPath}`);
  console.log(`Rules:  ${policy.rules.length}`);
  console.log("═".repeat(60));
  console.log();

  // List rules
  for (const rule of policy.rules) {
    const matchParts: string[] = [];
    if (rule.match.confidence) matchParts.push(`confidence=${rule.match.confidence}`);
    if (rule.match.files?.length) matchParts.push(`files=${rule.match.files.join(",")}`);
    if (matchParts.length === 0) matchParts.push("(unconditional)");
    console.log(`  [${rule.action}] ${rule.name} — ${matchParts.join("; ")}`);
  }
  console.log();

  // Run test scenarios
  console.log("Dry-run scenarios:");
  console.log("─".repeat(60));

  for (const scenario of TEST_SCENARIOS) {
    const result = evaluateScenario(policy, scenario);
    const icon = result.action === "auto-approve" ? "✓"
      : result.action === "block" ? "✗"
      : "?";
    console.log(`  ${icon} ${scenario.name}`);
    console.log(`    Action: ${result.action}`);
    if (result.matched_rules.length > 0) {
      console.log(`    Matched: ${result.matched_rules.join(", ")}`);
    } else {
      console.log(`    Matched: (none — default require-review)`);
    }
    console.log();
  }

  return 0;
}

interface TestScenario {
  name: string;
  confidence: ConfidenceLevel;
  diff: DiffStats;
}

const TEST_SCENARIOS: TestScenario[] = [
  {
    name: "Small safe change (1 file, 5 lines)",
    confidence: "safe",
    diff: {
      files_changed: 1,
      additions: 4,
      deletions: 1,
      files: [{ filename: "src/app.ts", additions: 4, deletions: 1, status: "modified" }],
    },
  },
  {
    name: "Needs-review change (10 files)",
    confidence: "needs_review",
    diff: {
      files_changed: 10,
      additions: 100,
      deletions: 30,
      files: Array.from({ length: 10 }, (_, i) => ({
        filename: `src/module${i}.ts`,
        additions: 10,
        deletions: 3,
        status: "modified" as const,
      })),
    },
  },
  {
    name: "Critical change (migration + lock file)",
    confidence: "critical",
    diff: {
      files_changed: 3,
      additions: 50,
      deletions: 10,
      files: [
        { filename: "db/migration_002.sql", additions: 30, deletions: 0, status: "added" },
        { filename: "bun.lock", additions: 15, deletions: 10, status: "modified" },
        { filename: "src/db.ts", additions: 5, deletions: 0, status: "modified" },
      ],
    },
  },
  {
    name: "Dockerfile change",
    confidence: "needs_review",
    diff: {
      files_changed: 1,
      additions: 3,
      deletions: 1,
      files: [{ filename: "Dockerfile", additions: 3, deletions: 1, status: "modified" }],
    },
  },
  {
    name: "CI config change",
    confidence: "needs_review",
    diff: {
      files_changed: 1,
      additions: 10,
      deletions: 2,
      files: [{ filename: ".github/workflows/ci.yml", additions: 10, deletions: 2, status: "modified" }],
    },
  },
];

function evaluateScenario(
  policy: PolicyConfig,
  scenario: TestScenario
): { action: string; matched_rules: string[] } {
  if (policy.rules.length === 0) {
    return { action: "require-review", matched_rules: [] };
  }

  const matched: string[] = [];
  let finalAction: "auto-approve" | "require-review" | "block" = "auto-approve";

  for (const rule of policy.rules) {
    if (ruleMatches(rule, scenario.diff, scenario.confidence)) {
      matched.push(rule.name);
      const priority = actionPriority(rule.action);
      if (priority > actionPriority(finalAction)) {
        finalAction = rule.action;
      }
    }
  }

  if (matched.length === 0) {
    return { action: "require-review", matched_rules: [] };
  }

  return { action: finalAction, matched_rules: matched };
}

// Re-implement locally to avoid circular dep with engine/policy (which needs ForgejoClient)
import { matchGlob } from "../engine/review";
import type { PolicyRule } from "../types";

function ruleMatches(
  rule: PolicyRule,
  diff: DiffStats,
  confidence: ConfidenceLevel
): boolean {
  if (rule.match.confidence && rule.match.confidence !== confidence) return false;
  if (rule.match.files?.length) {
    const hasMatch = diff.files.some((f) =>
      rule.match.files!.some((p) => matchGlob(p, f.filename))
    );
    if (!hasMatch) return false;
  }
  return true;
}

function actionPriority(action: string): number {
  switch (action) {
    case "auto-approve": return 0;
    case "require-review": return 1;
    case "block": return 2;
    default: return 1;
  }
}

function validatePolicy(raw: unknown): PolicyConfig {
  if (!raw || typeof raw !== "object") return { rules: [] };
  const obj = raw as Record<string, unknown>;
  const rawRules = Array.isArray(obj.rules) ? obj.rules : [];
  const rules: PolicyRule[] = rawRules
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map((r) => ({
      name: String(r.name ?? "unnamed"),
      match: {
        files: Array.isArray((r.match as any)?.files) ? (r.match as any).files.map(String) : undefined,
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
  return "require-review";
}
