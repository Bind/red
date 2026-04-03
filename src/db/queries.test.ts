import { describe, test, expect, beforeEach } from "bun:test";
import { initInMemoryDatabase } from "./schema";
import { ChangeQueries, EventQueries, JobQueries, DeliveryQueries, PullRequestQueries } from "./queries";
import type { Database } from "bun:sqlite";

let db: Database;
let changes: ChangeQueries;
let events: EventQueries;
let jobs: JobQueries;
let deliveries: DeliveryQueries;
let pullRequests: PullRequestQueries;

beforeEach(() => {
  db = initInMemoryDatabase();
  changes = new ChangeQueries(db);
  events = new EventQueries(db);
  jobs = new JobQueries(db);
  deliveries = new DeliveryQueries(db);
  pullRequests = new PullRequestQueries(db);
});

describe("ChangeQueries", () => {
  const makeChange = (overrides: Partial<Parameters<ChangeQueries["create"]>[0]> = {}) =>
    changes.create({
      org_id: "default",
      repo: "owner/repo",
      branch: "feature-1",
      base_branch: "main",
      head_sha: "abc123",
      created_by: "human",
      delivery_id: `del-${Math.random()}`,
      ...overrides,
    });

  test("create and getById", () => {
    const c = makeChange();
    expect(c.id).toBeGreaterThan(0);
    expect(c.status).toBe("pushed");
    expect(c.repo).toBe("owner/repo");

    const fetched = changes.getById(c.id);
    expect(fetched).toEqual(c);
  });

  test("getByDeliveryId", () => {
    const c = makeChange({ delivery_id: "unique-del-1" });
    expect(changes.getByDeliveryId("unique-del-1")).toEqual(c);
    expect(changes.getByDeliveryId("nonexistent")).toBeNull();
  });

  test("delivery_id uniqueness enforced", () => {
    makeChange({ delivery_id: "dup-1" });
    expect(() => makeChange({ delivery_id: "dup-1" })).toThrow();
  });

  test("updateStatus", () => {
    const c = makeChange();
    changes.updateStatus(c.id, "scoring");
    expect(changes.getById(c.id)!.status).toBe("scoring");
  });

  test("updateConfidence", () => {
    const c = makeChange();
    changes.updateConfidence(c.id, "safe");
    expect(changes.getById(c.id)!.confidence).toBe("safe");
  });

  test("updateSummary", () => {
    const c = makeChange();
    changes.updateSummary(c.id, "Fixed a bug");
    expect(changes.getById(c.id)!.summary).toBe("Fixed a bug");
  });

  test("supersedePrior marks open changes on same branch", () => {
    const c1 = makeChange({ delivery_id: "d1" });
    const c2 = makeChange({ delivery_id: "d2" });
    const c3 = makeChange({ delivery_id: "d3", branch: "other-branch" });

    const count = changes.supersedePrior("owner/repo", "feature-1", c2.id);
    expect(count).toBe(1);
    expect(changes.getById(c1.id)!.status).toBe("superseded");
    expect(changes.getById(c2.id)!.status).toBe("pushed"); // excluded
    expect(changes.getById(c3.id)!.status).toBe("pushed"); // different branch
  });

  test("supersedePrior ignores terminal states", () => {
    const c1 = makeChange({ delivery_id: "d1" });
    changes.updateStatus(c1.id, "merged" as any);
    const c2 = makeChange({ delivery_id: "d2" });
    const count = changes.supersedePrior("owner/repo", "feature-1", c2.id);
    expect(count).toBe(0);
  });

  test("listByStatus", () => {
    makeChange({ delivery_id: "d1" });
    makeChange({ delivery_id: "d2" });
    const c3 = makeChange({ delivery_id: "d3" });
    changes.updateStatus(c3.id, "scoring");

    expect(changes.listByStatus("pushed")).toHaveLength(2);
    expect(changes.listByStatus("scoring")).toHaveLength(1);
  });

  test("listForReview sorts by confidence priority", () => {
    const c1 = makeChange({ delivery_id: "d1" });
    const c2 = makeChange({ delivery_id: "d2" });
    const c3 = makeChange({ delivery_id: "d3" });

    changes.updateStatus(c1.id, "ready_for_review");
    changes.updateConfidence(c1.id, "safe");
    changes.updateStatus(c2.id, "ready_for_review");
    changes.updateConfidence(c2.id, "critical");
    changes.updateStatus(c3.id, "scored");
    changes.updateConfidence(c3.id, "needs_review");

    const list = changes.listForReview();
    expect(list).toHaveLength(3);
    expect(list[0].confidence).toBe("critical");
    expect(list[1].confidence).toBe("needs_review");
    expect(list[2].confidence).toBe("safe");
  });

  test("mergeVelocity", () => {
    const c1 = makeChange({ delivery_id: "d1" });
    const c2 = makeChange({ delivery_id: "d2" });
    changes.updateStatus(c1.id, "ready_for_review");
    changes.updateStatus(c2.id, "ready_for_review");

    const v = changes.mergeVelocity(24);
    expect(v.summarized).toBe(2);
    expect(v.pending_review).toBe(2);
  });
});

describe("EventQueries", () => {
  test("append and listByChangeId", () => {
    const c = changes.create({
      org_id: "default",
      repo: "r",
      branch: "b",
      base_branch: "main",
      head_sha: "s",
      created_by: "human",
      delivery_id: "ev-1",
    });

    events.append({
      change_id: c.id,
      event_type: "status_change",
      from_status: "pushed",
      to_status: "scoring",
    });
    events.append({
      change_id: c.id,
      event_type: "status_change",
      from_status: "scoring",
      to_status: "scored",
    });

    const list = events.listByChangeId(c.id);
    expect(list).toHaveLength(2);
    expect(list[0].from_status).toBe("pushed");
    expect(list[1].from_status).toBe("scoring");
  });
});

describe("JobQueries", () => {
  test("enqueue and claimNext", () => {
    const job = jobs.enqueue({
      org_id: "default",
      type: "score_change",
      payload: '{"change_id":1}',
    });
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);

    const claimed = jobs.claimNext("score_change");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.status).toBe("processing");
    expect(claimed!.attempts).toBe(1);

    // No more jobs to claim
    expect(jobs.claimNext("score_change")).toBeNull();
  });

  test("complete marks job as completed", () => {
    const job = jobs.enqueue({
      org_id: "default",
      type: "test",
      payload: "{}",
    });
    const claimed = jobs.claimNext();
    jobs.complete(claimed!.id);
    const after = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
    expect(after.status).toBe("completed");
  });

  test("fail with retries remaining re-queues as pending", () => {
    const job = jobs.enqueue({
      org_id: "default",
      type: "test",
      payload: "{}",
      max_attempts: 3,
    });
    jobs.claimNext();
    jobs.fail(job.id, "timeout");
    const after = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
    expect(after.status).toBe("pending");
    expect(after.last_error).toBe("timeout");
  });

  test("fail at max attempts marks as dead", () => {
    const job = jobs.enqueue({
      org_id: "default",
      type: "test",
      payload: "{}",
      max_attempts: 1,
    });
    jobs.claimNext(); // attempts becomes 1
    jobs.fail(job.id, "permanent failure");
    const after = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as any;
    expect(after.status).toBe("dead");
    expect(after.last_error).toBe("permanent failure");
  });

  test("pendingCount", () => {
    expect(jobs.pendingCount()).toBe(0);
    jobs.enqueue({ org_id: "default", type: "a", payload: "{}" });
    jobs.enqueue({ org_id: "default", type: "b", payload: "{}" });
    expect(jobs.pendingCount()).toBe(2);
  });
});

describe("DeliveryQueries", () => {
  test("isDuplicate and record", () => {
    expect(deliveries.isDuplicate("del-1")).toBe(false);
    deliveries.record("del-1");
    expect(deliveries.isDuplicate("del-1")).toBe(true);
  });

  test("record is idempotent (INSERT OR IGNORE)", () => {
    deliveries.record("del-2");
    deliveries.record("del-2"); // should not throw
    expect(deliveries.isDuplicate("del-2")).toBe(true);
  });
});

describe("PullRequestQueries", () => {
  const makeChange = () =>
    changes.create({
      org_id: "default",
      repo: "owner/repo",
      branch: "feature-1",
      base_branch: "main",
      head_sha: "abc123",
      created_by: "human",
      delivery_id: `pr-${Math.random()}`,
    });

  test("create and getLatestByChangeId", () => {
    const change = makeChange();
    const pr = pullRequests.create({
      change_id: change.id,
      repo: change.repo,
      head_branch: change.branch,
      base_branch: change.base_branch,
      title: "Add feature",
      body: "PR body",
      status: "open",
    });

    expect(pr.id).toBeGreaterThan(0);
    expect(pullRequests.getLatestByChangeId(change.id)?.title).toBe("Add feature");
  });

  test("updateStatus, attachProviderRef, and markMerged", () => {
    const change = makeChange();
    const pr = pullRequests.create({
      change_id: change.id,
      repo: change.repo,
      head_branch: change.branch,
      base_branch: change.base_branch,
      title: "Ship it",
    });

    pullRequests.updateStatus(pr.id, "approved");
    pullRequests.attachProviderRef(pr.id, "forgejo", "42");
    pullRequests.markMerged(pr.id, "deadbeef");

    const updated = pullRequests.getById(pr.id)!;
    expect(updated.status).toBe("merged");
    expect(updated.provider).toBe("forgejo");
    expect(updated.provider_ref).toBe("42");
    expect(updated.merge_commit_sha).toBe("deadbeef");
  });

  test("updateDetails rewrites title and body", () => {
    const change = makeChange();
    const pr = pullRequests.create({
      change_id: change.id,
      repo: change.repo,
      head_branch: change.branch,
      base_branch: change.base_branch,
      title: "Initial title",
    });

    pullRequests.updateDetails(pr.id, "New title", "Updated body");

    const updated = pullRequests.getById(pr.id)!;
    expect(updated.title).toBe("New title");
    expect(updated.body).toBe("Updated body");
  });
});
