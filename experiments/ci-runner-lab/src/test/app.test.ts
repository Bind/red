import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../service/app";
import { InlineShellExecutorBackend } from "../service/executor-backend";
import { LocalAttemptQueue, LocalJobsService, LocalWorker } from "../service/runner";
import { FileJobStore } from "../store/run-store";
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
  const store = new FileJobStore(config.runsFile);
  const queue = new LocalAttemptQueue(store);
  const backend = new InlineShellExecutorBackend();
  const worker = new LocalWorker("worker-test", config, store, queue, backend);
  const jobs = new LocalJobsService(store, queue, worker);
  return createApp(config, jobs);
}

describe("createApp", () => {
  test("queues a job and returns initial attempt state", async () => {
    const app = createTestApp();

    const response = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "red/example",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        jobName: "test",
        gitCredentialGrant: "grant-1",
        env: {
          JOB_SAMPLE: "value",
        },
      }),
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      queued: boolean;
      job: { latestAttempt: { status: string } | null };
    };
    expect(body.queued).toBe(true);
    expect(body.job.latestAttempt?.status).toBe("queued");
  });

  test("rejects invalid env keys", async () => {
    const app = createTestApp();

    const response = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoId: "red/example",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        jobName: "test",
        gitCredentialGrant: "grant-1",
        env: {
          BAD_KEY: "value",
        },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("JOB_");
  });
});
