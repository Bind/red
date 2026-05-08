import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ChangeQueries, EventQueries, JobQueries } from "../db/queries";
import { initInMemoryDatabase } from "../db/schema";
import { ScoringEngine } from "../engine/review";
import { ChangeStateMachine } from "../engine/state-machine";
import type { RepositoryProvider } from "../repo/repository-provider";
import { NotificationSender } from "./notify";
import { JobWorker, type WorkerDeps } from "./worker";

let db: Database;
let deps: WorkerDeps;
let worker: JobWorker;

let repositoryCallLog: Array<{ method: string; args: unknown[] }>;

function createMockRepositoryProvider(): RepositoryProvider {
  repositoryCallLog = [];
  return {
    compareDiff: mock(async () => {
      repositoryCallLog.push({ method: "compareDiff", args: [] });
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
      repositoryCallLog.push({ method: "getDiff", args: [] });
      return "diff --git a/src/app.ts b/src/app.ts\n+console.log('hello')";
    }),
    getFileContent: mock(async () => {
      repositoryCallLog.push({ method: "getFileContent", args: [] });
      return null; // no policy file
    }),
  };
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
    repositoryProvider: createMockRepositoryProvider(),
    scorer: new ScoringEngine(),
    stateMachine: new ChangeStateMachine(changes, events),
    notifier: new NotificationSender(),
    notificationConfigs: [],
  };

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

  test("score_change: scoring transitions through scored to ready_for_review", async () => {
    const changeId = createTestChange();
    deps.jobs.enqueue({
      org_id: "default",
      type: "score_change",
      payload: JSON.stringify({ change_id: changeId }),
    });

    const job = await worker.tick();
    expect(job).not.toBeNull();
    expect(job!.type).toBe("score_change");

    const change = deps.changes.getById(changeId)!;
    expect(change.status).toBe("ready_for_review");
    expect(change.confidence).not.toBeNull();
    expect(change.pr_number).toBeNull();

    expect(deps.jobs.pendingCount()).toBe(0);
    expect(repositoryCallLog.map((entry) => entry.method)).toContain("compareDiff");

    const events = deps.events.listByChangeId(changeId);
    const transitions = events
      .filter((e) => e.event_type === "status_change")
      .map((e) => `${e.from_status}→${e.to_status}`);
    expect(transitions).toEqual(["pushed→scoring", "scoring→scored", "scored→ready_for_review"]);
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
