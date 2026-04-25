import { describe, expect, test } from "bun:test";
import { createProposeTool, type ProposalCapture } from "../tools/propose";

describe("propose tool", () => {
  test("captures a single-line replacement with default endLine", async () => {
    const capture: ProposalCapture = { proposals: [] };
    const tool = createProposeTool(capture);
    const result = await tool.execute("call_1", {
      file: "README.md",
      line: 17,
      replacement: "just typecheck",
      reason: "fix typo",
    });
    expect(capture.proposals).toEqual([
      {
        file: "README.md",
        line: 17,
        endLine: 17,
        replacement: "just typecheck",
        reason: "fix typo",
      },
    ]);
    expect(result.content[0]?.text).toContain("README.md lines 17-17");
  });

  test("captures multi-line ranges and accumulates across calls", async () => {
    const capture: ProposalCapture = { proposals: [] };
    const tool = createProposeTool(capture);
    await tool.execute("call_1", {
      file: "README.md",
      line: 14,
      endLine: 16,
      replacement: "block one\nblock two\nblock three",
    });
    await tool.execute("call_2", {
      file: "justfile",
      line: 5,
      replacement: "verify: lint typecheck test",
    });
    expect(capture.proposals).toHaveLength(2);
    expect(capture.proposals[0]?.endLine).toBe(16);
    expect(capture.proposals[1]?.file).toBe("justfile");
    expect(capture.proposals[1]?.endLine).toBe(5);
  });

  test("rejects ranges where endLine precedes line", async () => {
    const capture: ProposalCapture = { proposals: [] };
    const tool = createProposeTool(capture);
    const result = await tool.execute("call_1", {
      file: "README.md",
      line: 20,
      endLine: 15,
      replacement: "x",
    });
    expect(capture.proposals).toEqual([]);
    expect(result.content[0]?.text).toContain("propose rejected");
    expect((result.details as { error: string }).error).toBe("endLine_before_line");
  });

  test("captures empty replacement as a deletion", async () => {
    const capture: ProposalCapture = { proposals: [] };
    const tool = createProposeTool(capture);
    await tool.execute("call_1", {
      file: "README.md",
      line: 18,
      endLine: 18,
      replacement: "",
    });
    expect(capture.proposals[0]?.replacement).toBe("");
  });
});
