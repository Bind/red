import { describe, test, expect } from "bun:test";
import { PolicyEngine } from "./policy";
import type { PolicyConfig, DiffStats } from "../types";
import type { RepositoryProvider } from "../repo/repository-provider";

// Minimal mock — we only test evaluate() here, loadPolicy() needs integration tests
const mockRepoProvider = {} as RepositoryProvider;
const engine = new PolicyEngine(mockRepoProvider);

function makeDiff(overrides: Partial<DiffStats> = {}): DiffStats {
  return {
    files_changed: 2,
    additions: 20,
    deletions: 5,
    files: [
      { filename: "src/app.ts", additions: 15, deletions: 3, status: "modified" },
      { filename: "src/utils.ts", additions: 5, deletions: 2, status: "modified" },
    ],
    ...overrides,
  };
}

describe("PolicyEngine.evaluate", () => {
  test("null policy → require-review (safe default)", () => {
    const result = engine.evaluate(null, makeDiff(), "safe");
    expect(result.action).toBe("require-review");
    expect(result.matchedRules[0].reason).toBe("No policy configured");
  });

  test("empty rules → require-review", () => {
    const policy: PolicyConfig = { rules: [] };
    const result = engine.evaluate(policy, makeDiff(), "safe");
    expect(result.action).toBe("require-review");
  });

  test("confidence match triggers rule", () => {
    const policy: PolicyConfig = {
      rules: [
        { name: "auto-safe", match: { confidence: "safe" }, action: "auto-approve" },
      ],
    };
    const result = engine.evaluate(policy, makeDiff(), "safe");
    expect(result.action).toBe("auto-approve");
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].rule).toBe("auto-safe");
  });

  test("confidence mismatch → no match → require-review", () => {
    const policy: PolicyConfig = {
      rules: [
        { name: "auto-safe", match: { confidence: "safe" }, action: "auto-approve" },
      ],
    };
    const result = engine.evaluate(policy, makeDiff(), "critical");
    expect(result.action).toBe("require-review");
  });

  test("file pattern match", () => {
    const policy: PolicyConfig = {
      rules: [
        { name: "block-migrations", match: { files: ["*.sql"] }, action: "block" },
      ],
    };
    const diff = makeDiff({
      files: [
        { filename: "db/001.sql", additions: 5, deletions: 0, status: "added" },
      ],
    });
    const result = engine.evaluate(policy, diff, "safe");
    expect(result.action).toBe("block");
  });

  test("multiple rules — highest priority wins", () => {
    const policy: PolicyConfig = {
      rules: [
        { name: "approve-safe", match: { confidence: "safe" }, action: "auto-approve" },
        { name: "block-infra", match: { files: ["Dockerfile*"] }, action: "block" },
      ],
    };
    const diff = makeDiff({
      files: [
        { filename: "src/app.ts", additions: 5, deletions: 0, status: "modified" },
        { filename: "Dockerfile", additions: 1, deletions: 0, status: "modified" },
      ],
    });
    const result = engine.evaluate(policy, diff, "safe");
    expect(result.action).toBe("block");
    expect(result.matchedRules).toHaveLength(2);
  });

  test("rule with both confidence and files requires both to match", () => {
    const policy: PolicyConfig = {
      rules: [
        {
          name: "review-critical-sql",
          match: { confidence: "critical", files: ["*.sql"] },
          action: "block",
        },
      ],
    };
    // Has SQL file but confidence is safe → no match
    const diff = makeDiff({
      files: [{ filename: "schema.sql", additions: 10, deletions: 0, status: "added" }],
    });
    const result = engine.evaluate(policy, diff, "safe");
    expect(result.action).toBe("require-review"); // fell through to default
  });

  test("unconditional rule matches everything", () => {
    const policy: PolicyConfig = {
      rules: [
        { name: "always-review", match: {}, action: "require-review" },
      ],
    };
    const result = engine.evaluate(policy, makeDiff(), "safe");
    expect(result.action).toBe("require-review");
    expect(result.matchedRules[0].rule).toBe("always-review");
  });
});
