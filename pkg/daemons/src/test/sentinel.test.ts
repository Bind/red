import { describe, expect, test } from "bun:test";
import { parseCompleteSentinel } from "../sentinel";

describe("parseCompleteSentinel", () => {
  test("returns none when no fence is present", () => {
    const r = parseCompleteSentinel("Still working on it. Will continue next turn.");
    expect(r.kind).toBe("none");
  });

  test("extracts a valid complete block", () => {
    const msg = [
      "Done with the sweep.",
      "",
      "```complete",
      JSON.stringify({
        summary: "nothing drifted",
        findings: [{ invariant: "summary_matches_commit", status: "ok" }],
      }),
      "```",
    ].join("\n");
    const r = parseCompleteSentinel(msg);
    expect(r.kind).toBe("complete");
    if (r.kind === "complete") {
      expect(r.payload.summary).toBe("nothing drifted");
      expect(r.payload.findings).toHaveLength(1);
    }
  });

  test("reports malformed JSON", () => {
    const msg = "```complete\n{not json}\n```";
    const r = parseCompleteSentinel(msg);
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") {
      expect(r.reason).toContain("invalid JSON");
    }
  });

  test("reports malformed when payload fails validation", () => {
    const msg = `\`\`\`complete\n${JSON.stringify({
      summary: "ok",
      findings: [{ invariant: "BAD", status: "ok" }],
    })}\n\`\`\``;
    const r = parseCompleteSentinel(msg);
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") {
      expect(r.reason).toContain("invariant");
    }
  });

  test("reports malformed when the fence body is empty", () => {
    const r = parseCompleteSentinel("```complete\n\n```");
    expect(r.kind).toBe("malformed");
  });

  test("accepts a pretty-printed JSON block with trailing whitespace", () => {
    const msg = "```complete\n" + JSON.stringify({ summary: "ok" }, null, 2) + "\n   \n```";
    const r = parseCompleteSentinel(msg);
    expect(r.kind).toBe("complete");
  });
});
