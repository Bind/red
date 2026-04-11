import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunnerService } from "../service/runner";
import { FileRunStore } from "../store/run-store";
import type { RunnerConfig } from "../util/types";

function createRunner() {
  const root = mkdtempSync(join(tmpdir(), "ci-runner-lab-runner-"));
  const config: RunnerConfig = {
    mode: "dev",
    hostname: "127.0.0.1",
    port: 4091,
    dataDir: root,
    runsFile: join(root, "runs.json"),
    workDir: join(root, "work"),
    maxConcurrentRuns: 1,
    stepTimeoutMs: 10000,
  };
  const store = new FileRunStore(config.runsFile);
  const runner = new LocalRunnerService(config, store);
  return { runner, store };
}

async function waitForCompletion(
  lookup: () =>
    | {
        status: string;
        stepResults: Array<{ stdout: string; status: string; exitCode?: number }>;
      }
    | undefined,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = lookup();
    if (run && (run.status === "success" || run.status === "failed")) {
      return run;
    }
    await Bun.sleep(25);
  }
  throw new Error("run did not complete");
}

describe("LocalRunnerService", () => {
  test("executes queued steps in order", async () => {
    const { runner, store } = createRunner();
    const queued = runner.queueRun({
      workflowName: "smoke",
      repository: "redc/example",
      ref: "refs/heads/main",
      steps: [
        { name: "first", run: "echo alpha" },
        { name: "second", run: "echo beta" },
      ],
    });

    const completed = await waitForCompletion(() => store.getRun(queued.id));

    expect(completed.status).toBe("success");
    expect(completed.stepResults).toHaveLength(2);
    expect(completed.stepResults[0]?.stdout).toContain("alpha");
    expect(completed.stepResults[1]?.stdout).toContain("beta");
  });

  test("marks the run failed when a step exits non-zero", async () => {
    const { runner, store } = createRunner();
    const queued = runner.queueRun({
      workflowName: "failure",
      repository: "redc/example",
      ref: "refs/heads/main",
      steps: [{ name: "fail", run: "echo nope >&2 && exit 7" }],
    });

    const completed = await waitForCompletion(() => store.getRun(queued.id));

    expect(completed.status).toBe("failed");
    expect(completed.stepResults[0]?.status).toBe("failed");
    expect(completed.stepResults[0]?.exitCode).toBe(7);
  });
});
