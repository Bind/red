import { describe, test, expect, beforeEach, mock } from "bun:test";
import { initInMemoryDatabase } from "../db/schema";
import { ChangeQueries, EventQueries, JobQueries, DeliveryQueries } from "../db/queries";
import { ScoringEngine } from "../engine/review";
import { PolicyEngine } from "../engine/policy";
import { StubSummaryGenerator } from "../engine/summary";
import { ChangeStateMachine } from "../engine/state-machine";
import { JobWorker, type WorkerDeps } from "./worker";
import { NotificationSender } from "./notify";
import type { ForgejoClient } from "../forgejo/client";
import type { Database } from "bun:sqlite";

let db: Database;
let deps: WorkerDeps;
let worker: JobWorker;

// Track Forgejo API calls
let forgejoCallLog: Array<{ method: string; args: unknown[] }>;

function createMockForgejo(): ForgejoClient {
  forgejoCallLog = [];
  return {
    compareDiff: mock(async () => {
      forgejoCallLog.push({ method: "compareDiff", args: [] });
      return {
        files_changed: 2,
        additions: 15,
        deletions: 3,
        files: [
          { filename: "src/app.ts", additions: 10, deletions: 2, status: "modified" as const },
          { filename: "src/util.ts", additions: 5, deletions: 1, status: "modified" as const },
        ],
      };
    }),
    getDiff: mock(async () => {
      forgejoCallLog.push({ method: "getDiff", args: [] });
      return "diff --git a/src/app.ts b/src/app.ts\n+console.log('hello')";
    }),
    setCommitStatus: mock(async () => {
      forgejoCallLog.push({ method: "setCommitStatus", args: [] });
    }),
    getFileContent: mock(async () => {
      forgejoCallLog.push({ method: "getFileContent", args: [] });
      return null; // no policy file
    }),
  } as unknown as ForgejoClient;
}

beforeEach(() => {
  db = initInMemoryDatabase();
  const changes = new ChangeQueries(db);
  const events = new EventQueries(db);
  const jobs = new JobQueries(db);

  deps = {
    changes,
    events,
    jobs,
    forgejo: createMockForgejo(),
    scorer: new ScoringEngine(),
    policy: new PolicyEngine(deps?.forgejo ?? createMockForgejo()),
    summary: new StubSummaryGenerator(),
    stateMachine: new ChangeStateMachine(changes, events),
    notifier: new NotificationSender(),
    notificationConfigs: [],
  };
  // Fix policy engine to use same forgejo mock
  deps.policy = new PolicyEngine(deps.forgejo);

  worker = new JobWorker(deps);
});

function createTestChange(): number {
  const change = deps.changes.create({
    org_id: "default",
    repo: "owner/repo",
    branch: "feature-1",
    base_branch: "main",
    head_sha: "abc123",
    created_by: "human",
    delivery_id: `del-${Math.random()}`,
  });
  deps.events.append({
    change_id: change.id,
    event_type: "push_received",
    to_status: "pushed",
    metadata: JSON.stringify({ commits: 1, sender: "dev" }),
  });
  return change.id;
}

describe("JobWorker", () => {
  test("tick returns null when no jobs", async () => {
    const result = await worker.tick();
    expect(result).toBeNull();
  });

  test("score_change: full scoring pipeline", async () => {
    const changeId = createTestChange();
    deps.jobs.enqueue({
      org_id: "default",
      type: "score_change",
      payload: JSON.stringify({ change_id: changeId }),
    });

    const job = await worker.tick();
    expect(job).not.toBeNull();
    expect(job!.type).toBe("score_change");

    // Change should be scored
    const change = deps.changes.getById(changeId)!;
    expect(change.status).toBe("summarizing");
    expect(change.confidence).not.toBeNull();

    // Should have enqueued a summary job
    expect(deps.jobs.pendingCount()).toBe(1);
    const summaryJob = deps.jobs.claimNext("generate_summary");
    expect(summaryJob).not.toBeNull();
  });

  test("generate_summary: full summary pipeline", async () => {
    const changeId = createTestChange();

    // Manually advance change to summarizing state
    deps.stateMachine.transition(changeId, "scoring");
    deps.changes.updateConfidence(changeId, "safe");
    deps.stateMachine.transition(changeId, "scored");
    deps.stateMachine.transition(changeId, "summarizing");

    deps.jobs.enqueue({
      org_id: "default",
      type: "generate_summary",
      payload: JSON.stringify({
        change_id: changeId,
        diff_stats: {
          files_changed: 2,
          additions: 15,
          deletions: 3,
          files: [
            { filename: "src/app.ts", additions: 10, deletions: 2, status: "modified" },
          ],
        },
        policy_decision: { action: "require-review" },
      }),
    });

    const job = await worker.tick();
    expect(job).not.toBeNull();

    const change = deps.changes.getById(changeId)!;
    expect(change.status).toBe("ready_for_review");
    expect(change.summary).not.toBeNull();

    const summary = JSON.parse(change.summary!);
    expect(summary.recommended_action).toBe("approve"); // safe confidence
  });

  test("full pipeline: score → summarize", async () => {
    const changeId = createTestChange();
    deps.jobs.enqueue({
      org_id: "default",
      type: "score_change",
      payload: JSON.stringify({ change_id: changeId }),
    });

    // First tick: scoring
    await worker.tick();

    // Second tick: summary
    await worker.tick();

    const change = deps.changes.getById(changeId)!;
    expect(change.status).toBe("ready_for_review");
    expect(change.confidence).not.toBeNull();
    expect(change.summary).not.toBeNull();

    // Verify event trail
    const events = deps.events.listByChangeId(changeId);
    const types = events.map((e) => e.event_type);
    expect(types).toContain("push_received");
    expect(types).toContain("status_change");
    expect(types).toContain("summary_generated");
  });

  test("skips superseded changes in score_change", async () => {
    const changeId = createTestChange();
    deps.changes.updateStatus(changeId, "superseded");

    deps.jobs.enqueue({
      org_id: "default",
      type: "score_change",
      payload: JSON.stringify({ change_id: changeId }),
    });

    await worker.tick();

    // Should still be superseded, no scoring happened
    const change = deps.changes.getById(changeId)!;
    expect(change.status).toBe("superseded");
  });

  test("failed job gets retried with backoff", async () => {
    // Enqueue a job with an unknown type to force an error
    deps.jobs.enqueue({
      org_id: "default",
      type: "unknown_type",
      payload: "{}",
      max_attempts: 3,
    });

    await worker.tick();

    // Job should be re-queued as pending with error
    const all = db.prepare("SELECT * FROM jobs").all() as any[];
    expect(all[0].status).toBe("pending");
    expect(all[0].last_error).toContain("Unknown job type");
    expect(all[0].attempts).toBe(1);
  });

  test("start and stop lifecycle", async () => {
    worker.start();
    // Double start should be idempotent
    worker.start();
    worker.stop();
    // Double stop should be safe
    worker.stop();
  });
});
