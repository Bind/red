import { describe, expect, test } from "bun:test";
import { parse } from "just-bash";
import { instrumentScript } from "../service/instrumentation";

describe("instrumentScript", () => {
  test("wraps simple commands in before and after hooks", () => {
    const original = parse("echo hi\nname=test\n");
    const instrumented = instrumentScript(original);

    expect(Object.keys(instrumented.commandNodes)).toEqual([
      "script.stmt0.pipe0.cmd0",
      "script.stmt1.pipe0.cmd0",
    ]);

    const first = instrumented.ast.statements[0]?.pipelines[0]?.commands[0] as {
      type: string;
      body: Array<{
        pipelines: Array<{
          commands: Array<{
            name?: { parts?: Array<{ value?: string }> };
          }>;
        }>;
      }>;
    };

    expect(first.type).toBe("Group");
    expect(first.body[0]?.pipelines[0]?.commands[0]?.name?.parts?.[0]?.value).toBe("__red_before");
    expect(first.body[2]?.pipelines[0]?.commands[0]?.name?.parts?.[0]?.value).toBe("__red_after");
  });
});
