import { expect, test } from "bun:test";
import { runRoutedDaemons, type DaemonExecutorInstance } from "./execute";

function spec(name: string) {
  return {
    name,
    file: `/tmp/${name}.daemon.md`,
    scopeRoot: `/tmp/${name}`,
  } as any;
}

function successfulOutcome(name: string) {
  return {
    name,
    ok: true,
    runId: `run_${name}`,
    summary: `${name} ok`,
    findings: [],
    wideEvents: [],
    turns: 1,
    tokens: { input: 1, output: 1 },
    viewedFiles: [],
    changedFiles: [],
    initialMemory: null,
    diff: "",
  };
}

test("runRoutedDaemons waits for in-flight workers before surfacing execution errors", async () => {
  const completed: string[] = [];
  const executor: DaemonExecutorInstance = {
    async run({ spec }) {
      if (spec.name === "alpha") {
        await Bun.sleep(5);
        throw new Error("alpha failed");
      }
      await Bun.sleep(20);
      completed.push(spec.name);
      return successfulOutcome(spec.name);
    },
  };

  await expect(
    runRoutedDaemons(
      [
        { name: "alpha", relevantFiles: ["a.ts"] },
        { name: "beta", relevantFiles: ["b.ts"] },
      ],
      new Map([
        ["alpha", spec("alpha")],
        ["beta", spec("beta")],
      ]),
      "/tmp/trusted",
      "/tmp/review",
      executor,
    ),
  ).rejects.toThrow("failed to run 1 daemon review task");

  expect(completed).toEqual(["beta"]);
});
