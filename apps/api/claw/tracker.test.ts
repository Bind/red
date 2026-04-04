import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteClawRunTracker } from "./tracker";
import type { ClawRunRecord } from "./types";

function makeTracker(): SqliteClawRunTracker {
  const dir = mkdtempSync(join(tmpdir(), "redc-claw-tracker-test-"));
  return new SqliteClawRunTracker(join(dir, "runs.db"));
}

function makeRecord(): ClawRunRecord {
  return {
    runId: "run-1",
    jobName: "generate-summary",
    jobId: "job-1",
    changeId: 12,
    workerId: "worker-1",
    repo: "redc-admin/redc",
    headRef: "abc123",
    baseRef: "main",
    image: "redc-claw-runner",
    containerName: "redc-generate-summary-run-1",
    containerId: null,
    codexSessionId: null,
    rolloutPath: null,
    status: "created",
    createdAt: "2026-04-01T01:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    errorType: null,
    errorMessage: null,
  };
}

test("tracker maps sqlite rows back to camelCase records", () => {
  const tracker = makeTracker();
  tracker.create(makeRecord());
  tracker.markRunning("run-1", "container-1", "2026-04-01T01:00:01.000Z");
  tracker.attachRollout(
    "run-1",
    "019d-run-session",
    "/root/.codex/sessions/2026/04/01/rollout-2026-04-01T01-00-01-019d-run-session.jsonl"
  );
  tracker.finish("run-1", {
    status: "failed",
    finishedAt: "2026-04-01T01:00:02.000Z",
    durationMs: 1000,
    errorType: "runtime_error",
    errorMessage: "container disappeared",
  });

  const record = tracker.getByRunId("run-1");
  expect(record).not.toBeNull();
  const existing = record!;
  expect(existing).toMatchObject({
    runId: "run-1",
    jobName: "generate-summary",
    jobId: "job-1",
    changeId: 12,
    workerId: "worker-1",
    repo: "redc-admin/redc",
    headRef: "abc123",
    baseRef: "main",
    image: "redc-claw-runner",
    containerName: "redc-generate-summary-run-1",
    containerId: "container-1",
    codexSessionId: "019d-run-session",
    rolloutPath: "/root/.codex/sessions/2026/04/01/rollout-2026-04-01T01-00-01-019d-run-session.jsonl",
    status: "failed",
    createdAt: "2026-04-01T01:00:00.000Z",
    startedAt: "2026-04-01T01:00:01.000Z",
    finishedAt: "2026-04-01T01:00:02.000Z",
    durationMs: 1000,
    errorType: "runtime_error",
    errorMessage: "container disappeared",
  });

  expect(tracker.listByStatus("failed", 10)).toEqual([existing]);
});
