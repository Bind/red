import { describe, test, expect } from "bun:test";
import { StubSummaryGenerator } from "./summary";
import type { SummaryInput } from "./summary";

const generator = new StubSummaryGenerator();

function makeInput(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    repo: "owner/repo",
    branch: "feature-1",
    baseRef: "main",
    headRef: "abc123",
    diff: "diff text",
    diffStats: {
      files_changed: 2,
      additions: 20,
      deletions: 5,
      files: [
        { filename: "src/app.ts", additions: 15, deletions: 3, status: "modified" },
        { filename: "src/utils.ts", additions: 5, deletions: 2, status: "modified" },
      ],
    },
    confidence: "safe",
    commitMessages: ["Add feature X", "Fix typo"],
    ...overrides,
  };
}

describe("StubSummaryGenerator", () => {
  test("generates summary with commit messages", async () => {
    const result = await generator.generate(makeInput());
    expect(result.what_changed).toBe("Add feature X; Fix typo");
    expect(result.affected_modules).toContain("src/app.ts".split("/").slice(0, 2).join("/"));
    expect(result.recommended_action).toBe("approve");
  });

  test("safe confidence → approve", async () => {
    const result = await generator.generate(makeInput({ confidence: "safe" }));
    expect(result.recommended_action).toBe("approve");
  });

  test("needs_review confidence → review", async () => {
    const result = await generator.generate(makeInput({ confidence: "needs_review" }));
    expect(result.recommended_action).toBe("review");
  });

  test("critical confidence → block", async () => {
    const result = await generator.generate(makeInput({ confidence: "critical" }));
    expect(result.recommended_action).toBe("block");
  });

  test("no commit messages falls back to stats", async () => {
    const result = await generator.generate(makeInput({ commitMessages: [] }));
    expect(result.what_changed).toContain("files changed");
  });

  test("risk assessment mentions deletion-heavy", async () => {
    const result = await generator.generate(makeInput({
      confidence: "needs_review",
      diffStats: {
        files_changed: 1,
        additions: 2,
        deletions: 50,
        files: [{ filename: "src/old.ts", additions: 2, deletions: 50, status: "modified" }],
      },
    }));
    expect(result.risk_assessment).toContain("deletions");
  });

  test("generates annotations grouped by file status", async () => {
    const result = await generator.generate(makeInput({
      diffStats: {
        files_changed: 4,
        additions: 30,
        deletions: 10,
        files: [
          { filename: "src/new.ts", additions: 10, deletions: 0, status: "added" },
          { filename: "src/another-new.ts", additions: 5, deletions: 0, status: "added" },
          { filename: "src/old.ts", additions: 0, deletions: 5, status: "deleted" },
          { filename: "src/app.ts", additions: 15, deletions: 5, status: "modified" },
        ],
      },
    }));
    expect(result.annotations).toBeDefined();
    expect(result.annotations!.length).toBe(3); // added, deleted, modified groups
    for (const ann of result.annotations!) {
      expect(ann.text).toBeTruthy();
      expect(ann.files.length).toBeGreaterThan(0);
      expect(["new_module", "refactor", "bugfix", "config", "change"]).toContain(ann.type);
    }
  });

  test("annotations cover all files from diffStats", async () => {
    const result = await generator.generate(makeInput());
    expect(result.annotations).toBeDefined();
    const allFiles = result.annotations!.flatMap((a) => a.files);
    expect(allFiles).toContain("src/app.ts");
    expect(allFiles).toContain("src/utils.ts");
  });

  test("extracts modules from file paths", async () => {
    const result = await generator.generate(makeInput({
      diffStats: {
        files_changed: 3,
        additions: 10,
        deletions: 5,
        files: [
          { filename: "src/api/handler.ts", additions: 5, deletions: 2, status: "modified" },
          { filename: "src/db/schema.ts", additions: 3, deletions: 3, status: "modified" },
          { filename: "README.md", additions: 2, deletions: 0, status: "modified" },
        ],
      },
    }));
    expect(result.affected_modules).toContain("src/api");
    expect(result.affected_modules).toContain("src/db");
    expect(result.affected_modules).toContain("README.md");
  });
});
