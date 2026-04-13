import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InlineShellExecutorBackend } from "../service/executor-backend";
import { LocalAttemptQueue, LocalJobsService, LocalWorker } from "../service/runner";
import { FileJobStore } from "../store/run-store";
import type { JobRecord, RunnerConfig } from "../util/types";

function createServices() {
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
  const store = new FileJobStore(config.runsFile);
  const queue = new LocalAttemptQueue(store);
  const backend = new InlineShellExecutorBackend();
  const worker = new LocalWorker("worker-test", config, store, queue, backend);
  const jobs = new LocalJobsService(store, queue, worker);
  return { jobs };
}

async function waitForTerminalState(lookup: () => JobRecord | undefined) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = lookup();
    const latest = record?.attempts[record.attempts.length - 1];
    if (latest && (latest.status === "success" || latest.status === "failed")) {
      return latest;
    }
    await Bun.sleep(25);
  }
  throw new Error("attempt did not reach terminal state");
}

describe("LocalJobsService", () => {
  test("creates a queued job and runs it through the worker", async () => {
    const { jobs } = createServices();
    const created = jobs.createJob({
      repoId: "redc/example",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobName: "test",
      gitCredentialGrant: "grant-1",
      env: {
        JOB_SAMPLE: "value",
      },
    });

    expect(created.attempts[0]?.status).toBe("queued");

    void jobs.tickWorker();
    const terminal = await waitForTerminalState(() => jobs.getJob(created.job.jobId));

    expect(terminal.status).toBe("success");
    expect(terminal.logs.some((chunk) => chunk.stream === "display")).toBe(true);
  });

  test("creates a retry attempt on the same job", async () => {
    const { jobs } = createServices();
    const created = jobs.createJob({
      repoId: "redc/example",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      jobName: "test",
      gitCredentialGrant: "grant-1",
      env: {
        JOB_SAMPLE: "value",
      },
    });

    const retried = jobs.retryJob(created.job.jobId, {
      gitCredentialGrant: "grant-2",
    });

    expect(retried.attempts).toHaveLength(2);
    expect(retried.attempts[1]?.attemptNumber).toBe(2);
  });
});
