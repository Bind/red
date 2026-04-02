import { beforeEach, describe, expect, test } from "bun:test";
import { initInMemoryDatabase } from "../db/schema";
import { ChangeQueries, DeliveryQueries, EventQueries, JobQueries } from "../db/queries";
import { ingestRefUpdate } from "./ref-updates";
import type { Database } from "bun:sqlite";

let db: Database;
let changes: ChangeQueries;
let events: EventQueries;
let deliveries: DeliveryQueries;
let jobs: JobQueries;

beforeEach(() => {
  db = initInMemoryDatabase();
  changes = new ChangeQueries(db);
  events = new EventQueries(db);
  deliveries = new DeliveryQueries(db);
  jobs = new JobQueries(db);
});

describe("ingestRefUpdate", () => {
  test("accepts a non-default-branch ref update", () => {
    const result = ingestRefUpdate(
      { changes, events, deliveries, jobs },
      {
        repo: "owner/repo",
        branch: "feature/test",
        baseBranch: "main",
        headSha: "abc123",
        createdBy: "human",
        metadata: { commits: 1, sender: "owner", source: "local_api" },
      }
    );

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    const change = changes.getById(result.change_id)!;
    expect(change.branch).toBe("feature/test");
    expect(change.status).toBe("pushed");
    expect(jobs.pendingCount()).toBe(1);
  });

  test("deduplicates when a delivery id is reused", () => {
    ingestRefUpdate(
      { changes, events, deliveries, jobs },
      {
        repo: "owner/repo",
        branch: "feature/test",
        baseBranch: "main",
        headSha: "abc123",
        createdBy: "human",
        deliveryId: "dup-1",
      }
    );

    const result = ingestRefUpdate(
      { changes, events, deliveries, jobs },
      {
        repo: "owner/repo",
        branch: "feature/test",
        baseBranch: "main",
        headSha: "abc123",
        createdBy: "human",
        deliveryId: "dup-1",
      }
    );

    expect(result).toEqual({ status: "duplicate", delivery_id: "dup-1" });
  });

  test("skips default branch updates", () => {
    const result = ingestRefUpdate(
      { changes, events, deliveries, jobs },
      {
        repo: "owner/repo",
        branch: "main",
        baseBranch: "main",
        headSha: "abc123",
        createdBy: "human",
        deliveryId: "main-1",
      }
    );

    expect(result).toEqual({
      status: "skipped",
      reason: "default branch",
      delivery_id: "main-1",
    });
    expect(jobs.pendingCount()).toBe(0);
  });
});
