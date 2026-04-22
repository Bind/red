import { describe, expect, test } from "bun:test";
import { createStaleIssueDaemon } from "../daemons/stale-issue";
import { DaemonKernel } from "../kernel";
import { createInMemoryRecorder } from "../wide-events";
import { IssueStore } from "../world/issue-store";

function fixed(now: Date): () => Date {
  return () => now;
}

describe("stale-issue daemon", () => {
  test("labels untriaged issues older than the threshold and skips fresh ones", async () => {
    const now = new Date("2026-04-22T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const store = new IssueStore();
    store.upsert({
      id: "iss_old",
      title: "Old and untriaged",
      openedAt: new Date(now.getTime() - 10 * day),
      labels: [],
      comments: [],
    });
    store.upsert({
      id: "iss_new",
      title: "New and untriaged",
      openedAt: new Date(now.getTime() - 1 * day),
      labels: [],
      comments: [],
    });
    store.upsert({
      id: "iss_labelled",
      title: "Old but already labelled",
      openedAt: new Date(now.getTime() - 30 * day),
      labels: ["bug"],
      comments: [],
    });

    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit, now: fixed(now) });
    kernel.register(createStaleIssueDaemon({ store, staleAfterDays: 7, intervalMs: 1_000 }));

    const result = await kernel.tickOnce("stale-issue");
    expect(result.healed).toBe(1);

    expect(store.get("iss_old")?.labels).toContain("needs-triage");
    expect(store.get("iss_old")?.comments.length).toBe(1);
    expect(store.get("iss_new")?.labels).toEqual([]);
    expect(store.get("iss_labelled")?.labels).toEqual(["bug"]);
  });

  test("does not re-label the same issue on a second tick", async () => {
    const now = new Date("2026-04-22T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const store = new IssueStore();
    store.upsert({
      id: "iss_old",
      title: "Old",
      openedAt: new Date(now.getTime() - 10 * day),
      labels: [],
      comments: [],
    });

    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit, now: fixed(now) });
    kernel.register(createStaleIssueDaemon({ store, staleAfterDays: 7, intervalMs: 1_000 }));

    await kernel.tickOnce("stale-issue");
    rec.drain();
    await kernel.tickOnce("stale-issue");

    const events = rec.drain();
    const applied = events.filter((e) => e.kind === "daemon.action.applied");
    expect(applied.length).toBe(0);
    expect(store.get("iss_old")?.comments.length).toBe(1);
    expect(store.get("iss_old")?.labels).toEqual(["needs-triage"]);
  });
});
