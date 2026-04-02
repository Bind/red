import { expect, test } from "bun:test";
import { summarizeRunnerLine } from "./runtime-adapter";

test("summarizeRunnerLine turns tool_use into readable lifecycle activity", () => {
  const event = summarizeRunnerLine(JSON.stringify({
    type: "tool_use",
    sessionID: "ses_123",
    part: {
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/work/repo/test-file.txt" },
        output: "file contents here",
      },
    },
  }));

  expect(event.kind).toBe("lifecycle");
  expect(event.type).toBe("tool.used");
  expect(event.status).toBe("completed");
  expect(event.role).toBe("tool");
  expect(event.text).toContain("Completed read");
  expect(event.text).toContain("/work/repo/test-file.txt");
});

test("summarizeRunnerLine keeps stderr/plain text as system messages", () => {
  const event = summarizeRunnerLine("Running OpenCode...");

  expect(event.kind).toBe("message");
  expect(event.role).toBe("system");
  expect(event.text).toBe("Running OpenCode...");
});

test("summarizeRunnerLine annotates step completions with reason and token count", () => {
  const event = summarizeRunnerLine(JSON.stringify({
    type: "step_finish",
    sessionID: "ses_123",
    part: {
      reason: "tool-calls",
      tokens: { total: 6720 },
    },
  }));

  expect(event.kind).toBe("lifecycle");
  expect(event.type).toBe("step.completed");
  expect(event.text).toContain("tool-calls");
  expect(event.text).toContain("6720 tokens");
});
