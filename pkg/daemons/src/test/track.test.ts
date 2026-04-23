import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonMemoryStore } from "../memory";
import { createTrackTool } from "../tools/track";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daemons-track-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("track tool", () => {
  test("records, looks up, and invalidates daemon-local facts", async () => {
    const store = await createDaemonMemoryStore("docs-command-surface", dir, join(dir, ".cache"));
    const tool = createTrackTool(store, "run_test_1");

    const recordResult = await tool.execute("call_1", {
      action: "record",
      subject: "README.md",
      fingerprint: "abc123",
      fact: { commands: ["just up"] },
      depends_on: [],
    });
    expect((recordResult.details as { entry: { subject: string } }).entry.subject).toBe("README.md");

    const lookupResult = await tool.execute("call_2", {
      action: "lookup",
      subject: "README.md",
    });
    const lookupEntries = (lookupResult.details as { entries: Array<{ subject: string; depends_on: string[] }> }).entries;
    expect(lookupEntries).toHaveLength(1);
    expect(lookupEntries[0]?.subject).toBe("README.md");
    expect(lookupEntries[0]?.depends_on).toEqual([]);

    const invalidateResult = await tool.execute("call_3", {
      action: "invalidate",
      subject: "README.md",
    });
    expect((invalidateResult.details as { removed: number }).removed).toBe(1);
    expect(store.lookup(["README.md"])).toEqual([]);
  });
});
