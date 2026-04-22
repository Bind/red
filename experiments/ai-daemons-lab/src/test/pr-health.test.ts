import { describe, expect, test } from "bun:test";
import { createPRHealthDaemon } from "../daemons/pr-health";
import { StubHealer } from "../healers/stub";
import { DaemonKernel } from "../kernel";
import { createInMemoryRecorder } from "../wide-events";
import { ChangeStore } from "../world/change-store";

function freshStore(): ChangeStore {
  const store = new ChangeStore();
  store.upsert({
    id: "chg_stale",
    title: "Stale summary case",
    commitSha: "newsha1",
    summary: "old body",
    summaryForSha: "oldsha",
    reviewers: ["alice"],
  });
  store.upsert({
    id: "chg_none",
    title: "Missing summary and reviewer",
    commitSha: "sha_n",
    summary: null,
    summaryForSha: null,
    reviewers: [],
  });
  store.upsert({
    id: "chg_ok",
    title: "Already fine",
    commitSha: "sha_ok",
    summary: "ok",
    summaryForSha: "sha_ok",
    reviewers: ["bob"],
  });
  return store;
}

describe("pr-health daemon", () => {
  test("regenerates stale summary and records memory for sha", async () => {
    const store = freshStore();
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    kernel.register(
      createPRHealthDaemon({ store, healer: new StubHealer(), intervalMs: 1_000 }),
    );

    const result = await kernel.tickOnce("pr-health");
    expect(result.healed).toBeGreaterThanOrEqual(2);

    const stale = store.get("chg_stale");
    expect(stale?.summaryForSha).toBe("newsha1");
    expect(stale?.summary).toContain("[auto]");
  });

  test("assigns default reviewer when none present", async () => {
    const store = freshStore();
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    kernel.register(
      createPRHealthDaemon({
        store,
        healer: new StubHealer(),
        intervalMs: 1_000,
        defaultReviewer: "red-bot",
      }),
    );

    await kernel.tickOnce("pr-health");
    expect(store.get("chg_none")?.reviewers).toContain("red-bot");
    expect(store.get("chg_ok")?.reviewers).toEqual(["bob"]);
  });

  test("does not re-heal the same sha on a second tick", async () => {
    const store = freshStore();
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    kernel.register(
      createPRHealthDaemon({ store, healer: new StubHealer(), intervalMs: 1_000 }),
    );

    await kernel.tickOnce("pr-health");
    const afterFirst = store.get("chg_stale");
    rec.drain();
    await kernel.tickOnce("pr-health");

    const events = rec.drain();
    const summaryApplied = events.filter(
      (e) => e.kind === "daemon.action.applied" && e.data.action === "regenerated_summary",
    );
    expect(summaryApplied.length).toBe(0);
    expect(store.get("chg_stale")?.summary).toBe(afterFirst?.summary ?? "");
  });

  test("memory skip suppresses re-heal when store write didn't stick", async () => {
    const store = new ChangeStore();
    store.upsert({
      id: "chg_x",
      title: "stuck stale",
      commitSha: "shaX",
      summary: "old",
      summaryForSha: "shaW",
      reviewers: ["alice"],
    });
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    const tracking: { calls: number } = { calls: 0 };
    const healer = {
      name: "counting-stub",
      async summarize(input: { changeId: string; title: string; commitSha: string }) {
        tracking.calls += 1;
        return `[auto] ${input.title} (${input.commitSha})`;
      },
    };
    kernel.register(createPRHealthDaemon({ store, healer, intervalMs: 1_000 }));

    await kernel.tickOnce("pr-health");
    expect(tracking.calls).toBe(1);

    store.upsert({
      id: "chg_x",
      title: "stuck stale",
      commitSha: "shaX",
      summary: "old",
      summaryForSha: "shaW",
      reviewers: ["alice"],
    });
    rec.drain();
    await kernel.tickOnce("pr-health");

    expect(tracking.calls).toBe(1);
    const skipped = rec.drain().filter((e) => e.kind === "daemon.finding.skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.data.reason).toBe("already_healed_for_sha");
  });

  test("re-heals when the commit sha advances again", async () => {
    const store = freshStore();
    const rec = createInMemoryRecorder();
    const kernel = new DaemonKernel({ emit: rec.emit });
    kernel.register(
      createPRHealthDaemon({ store, healer: new StubHealer(), intervalMs: 1_000 }),
    );

    await kernel.tickOnce("pr-health");
    store.advanceCommit("chg_stale", "newsha2");
    rec.drain();
    await kernel.tickOnce("pr-health");

    const events = rec.drain();
    const summaryApplied = events.filter(
      (e) => e.kind === "daemon.action.applied" && e.data.action === "regenerated_summary",
    );
    expect(summaryApplied.length).toBe(1);
    expect(store.get("chg_stale")?.summaryForSha).toBe("newsha2");
  });
});
