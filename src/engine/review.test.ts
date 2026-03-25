import { describe, test, expect } from "bun:test";
import { ScoringEngine, matchGlob } from "./review";
import type { DiffStats } from "../types";

const scorer = new ScoringEngine();

function makeDiff(overrides: Partial<DiffStats> = {}): DiffStats {
  return {
    files_changed: 1,
    additions: 10,
    deletions: 2,
    files: [
      { filename: "src/app.ts", additions: 10, deletions: 2, status: "modified" },
    ],
    ...overrides,
  };
}

describe("ScoringEngine", () => {
  test("small change → safe", () => {
    const result = scorer.score(makeDiff({ additions: 5, deletions: 2 }));
    expect(result.confidence).toBe("safe");
  });

  test("moderate change → needs_review", () => {
    const result = scorer.score(makeDiff({
      files_changed: 3,
      additions: 40,
      deletions: 20,
      files: [
        { filename: "src/a.ts", additions: 20, deletions: 10, status: "modified" },
        { filename: "src/b.ts", additions: 10, deletions: 5, status: "modified" },
        { filename: "src/c.ts", additions: 10, deletions: 5, status: "modified" },
      ],
    }));
    expect(result.confidence).toBe("needs_review");
  });

  test("large change → critical", () => {
    const result = scorer.score(makeDiff({
      files_changed: 25,
      additions: 400,
      deletions: 200,
      files: Array.from({ length: 25 }, (_, i) => ({
        filename: `src/file${i}.ts`,
        additions: 16,
        deletions: 8,
        status: "modified" as const,
      })),
    }));
    expect(result.confidence).toBe("critical");
  });

  test("sensitive file patterns → needs_review", () => {
    const result = scorer.score(makeDiff({
      additions: 3,
      deletions: 0,
      files: [
        { filename: "Dockerfile", additions: 3, deletions: 0, status: "modified" },
      ],
    }));
    expect(result.confidence).toBe("needs_review");
    expect(result.reasons.some((r) => r.includes("Sensitive"))).toBe(true);
  });

  test("lock file → needs_review", () => {
    const result = scorer.score(makeDiff({
      additions: 5,
      deletions: 2,
      files: [
        { filename: "bun.lock", additions: 5, deletions: 2, status: "modified" },
      ],
    }));
    expect(result.confidence).toBe("needs_review");
  });

  test("migration file → needs_review", () => {
    const result = scorer.score(makeDiff({
      additions: 5,
      deletions: 0,
      files: [
        { filename: "db/migration_001.sql", additions: 5, deletions: 0, status: "added" },
      ],
    }));
    expect(result.confidence).toBe("needs_review");
  });

  test("deletion-heavy change escalates", () => {
    const result = scorer.score(makeDiff({
      additions: 2,
      deletions: 30,
      files: [
        { filename: "src/old.ts", additions: 2, deletions: 30, status: "modified" },
      ],
    }));
    expect(result.confidence).toBe("needs_review");
    expect(result.reasons.some((r) => r.includes("Deletion-heavy"))).toBe(true);
  });

  test("custom config overrides thresholds", () => {
    const strict = new ScoringEngine({ safeLinesThreshold: 10, safeFilesThreshold: 1 });
    const result = strict.score(makeDiff({ additions: 12, deletions: 0 }));
    expect(result.confidence).toBe("needs_review");
  });

  test("empty diff → safe", () => {
    const result = scorer.score({
      files_changed: 0,
      additions: 0,
      deletions: 0,
      files: [],
    });
    expect(result.confidence).toBe("safe");
  });
});

describe("matchGlob", () => {
  test("exact match", () => {
    expect(matchGlob("Dockerfile", "Dockerfile")).toBe(true);
    expect(matchGlob("Dockerfile", "Dockerfile.prod")).toBe(false);
  });

  test("wildcard", () => {
    expect(matchGlob("*.ts", "app.ts")).toBe(true);
    expect(matchGlob("*.ts", "src/app.ts")).toBe(true);
    expect(matchGlob("*.lock", "bun.lock")).toBe(true);
  });

  test("double star", () => {
    expect(matchGlob(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(matchGlob("**/*.sql", "db/migrations/001.sql")).toBe(true);
  });

  test("prefix wildcard", () => {
    expect(matchGlob("Dockerfile*", "Dockerfile")).toBe(true);
    expect(matchGlob("Dockerfile*", "Dockerfile.prod")).toBe(true);
  });

  test("contains pattern", () => {
    expect(matchGlob("*migration*", "db/migration_001.sql")).toBe(true);
    expect(matchGlob("*migration*", "migration.ts")).toBe(true);
  });
});
