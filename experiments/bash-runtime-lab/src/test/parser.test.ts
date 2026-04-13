import { describe, expect, test } from "bun:test";
import { parseScript } from "../service/parser";

describe("parseScript", () => {
  test("splits ephemeral and durable blocks", () => {
    const segments = parseScript(
      ["echo before", "# @durable build", "echo build", "# @enddurable", "echo after"].join("\n"),
    );

    expect(segments).toEqual([
      {
        type: "ephemeral",
        id: "ephemeral-1",
        script: "echo before\n",
        startLine: 1,
        endLine: 1,
      },
      {
        type: "durable",
        id: "build",
        script: "echo build\n",
        startLine: 3,
        endLine: 3,
      },
      {
        type: "ephemeral",
        id: "ephemeral-3",
        script: "echo after\n",
        startLine: 5,
        endLine: 5,
      },
    ]);
  });

  test("rejects missing durable terminators", () => {
    expect(() => parseScript("# @durable build\necho hi\n")).toThrow(
      'Durable block "build" is missing # @enddurable',
    );
  });
});
