import { describe, expect, test } from "bun:test";
import { createCompleteTool, type CompleteCapture } from "../tools/complete";

describe("complete tool", () => {
  test("captures payload and invokes onComplete callback", async () => {
    const capture: CompleteCapture = {};
    const payloads = [] as Array<{ summary: string }>;
    const tool = createCompleteTool(capture, {
      onComplete(payload) {
        payloads.push({ summary: payload.summary });
      },
    });

    const result = await tool.execute("call_1", { summary: "finished cleanly" });
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(capture.payload?.summary).toBe("finished cleanly");
    expect(payloads).toEqual([{ summary: "finished cleanly" }]);
    expect(result.details.summary).toBe("finished cleanly");
  });
});
