import { describe, expect, test } from "bun:test";
import { CompletePayload, DaemonFrontmatter } from "../schema";

describe("DaemonFrontmatter", () => {
  test("accepts minimal valid shape", () => {
    const parsed = DaemonFrontmatter.safeParse({
      name: "pr-health",
      description: "Keep PR summaries current.",
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects unknown keys", () => {
    const parsed = DaemonFrontmatter.safeParse({
      name: "x",
      description: "d",
      on: ["pr.opened"],
    });
    expect(parsed.success).toBe(false);
  });

  test.each([
    ["Uppercase", false],
    ["a", true],
    ["a-1", true],
    ["1starts-with-digit", false],
    ["has_underscore", false],
    ["a".repeat(65), false],
  ])("name %s validates to %s", (name, ok) => {
    const parsed = DaemonFrontmatter.safeParse({ name, description: "d" });
    expect(parsed.success).toBe(ok);
  });

  test("rejects empty description and too-long description", () => {
    expect(DaemonFrontmatter.safeParse({ name: "x", description: "" }).success).toBe(false);
    expect(
      DaemonFrontmatter.safeParse({ name: "x", description: "a".repeat(201) }).success,
    ).toBe(false);
  });

  test("accepts review metadata", () => {
    const parsed = DaemonFrontmatter.safeParse({
      name: "infra-audit",
      description: "Audit infra",
      review: {
        max_turns: 18,
        routing_categories: [
          {
            name: "infra-ops",
            description: "Deploy and operator workflow files.",
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("CompletePayload", () => {
  test("accepts a full payload with findings", () => {
    const parsed = CompletePayload.safeParse({
      summary: "ran clean",
      findings: [
        {
          invariant: "summary_matches_commit",
          target: "chg_1",
          status: "healed",
          note: "regenerated",
        },
      ],
      nextRunHint: "recheck in 5m",
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts a payload with no findings and defaults to empty array", () => {
    const parsed = CompletePayload.safeParse({ summary: "nothing to do" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings).toEqual([]);
    }
  });

  test("rejects bad invariant tag", () => {
    const parsed = CompletePayload.safeParse({
      summary: "x",
      findings: [{ invariant: "BadTag", status: "ok" }],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects unknown finding status", () => {
    const parsed = CompletePayload.safeParse({
      summary: "x",
      findings: [{ invariant: "t", status: "wat" }],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects empty summary", () => {
    const parsed = CompletePayload.safeParse({ summary: "" });
    expect(parsed.success).toBe(false);
  });
});
