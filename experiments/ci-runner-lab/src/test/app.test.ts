import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../service/app";
import { LocalRunnerService } from "../service/runner";
import { FileRunStore } from "../store/run-store";
import type { RunnerConfig } from "../util/types";

function createTestApp() {
  const root = mkdtempSync(join(tmpdir(), "ci-runner-lab-app-"));
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
  return createApp(config, runner);
}

describe("createApp", () => {
  test("queues a run and returns its initial state", async () => {
    const app = createTestApp();

    const response = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowName: "unit",
        repository: "redc/example",
        ref: "refs/heads/main",
        steps: [{ name: "hello", run: "echo hi" }],
      }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as { queued: boolean; run: { status: string } };
    expect(body.queued).toBe(true);
    expect(body.run.status).toBe("queued");
  });

  test("rejects invalid requests", async () => {
    const app = createTestApp();

    const response = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowName: "unit",
        steps: [],
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("repository is required");
  });
});
