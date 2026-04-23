import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryPrompt,
  collectCheckedFiles,
  loadMemorySnapshot,
  normalizeCheckedPath,
  saveMemoryRecord,
} from "../memory";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daemons-memory-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("memory", () => {
  test("saves and reloads checked-file fingerprints", async () => {
    await mkdir(join(dir, "scope"));
    await writeFile(join(dir, "scope", "a.txt"), "one\n");
    const checkedFiles = await collectCheckedFiles(join(dir, "scope"), ["a.txt"]);

    await saveMemoryRecord(
      {
        version: 1,
        daemon: "demo",
        scopeRoot: join(dir, "scope"),
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastRun: {
          summary: "ok",
          findings: [],
          checkedFiles,
        },
      },
      join(dir, "scope"),
      join(dir, "cache"),
    );

    const snapshot = await loadMemorySnapshot("demo", join(dir, "scope"), join(dir, "cache"));
    expect(snapshot).not.toBeNull();
    expect(snapshot?.unchangedFiles.map((f) => f.path)).toEqual(["a.txt"]);
    expect(snapshot?.changedFiles).toHaveLength(0);
    expect(snapshot?.missingFiles).toHaveLength(0);
  });

  test("detects changed and missing files", async () => {
    await mkdir(join(dir, "scope"));
    await writeFile(join(dir, "scope", "a.txt"), "one\n");
    await writeFile(join(dir, "scope", "b.txt"), "two\n");
    const checkedFiles = await collectCheckedFiles(join(dir, "scope"), ["a.txt", "b.txt"]);

    await saveMemoryRecord(
      {
        version: 1,
        daemon: "demo",
        scopeRoot: join(dir, "scope"),
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastRun: {
          summary: "ok",
          findings: [{ invariant: "x", status: "ok" }],
          checkedFiles,
        },
      },
      join(dir, "scope"),
      join(dir, "cache"),
    );

    await writeFile(join(dir, "scope", "a.txt"), "changed\n");
    await rm(join(dir, "scope", "b.txt"));
    const snapshot = await loadMemorySnapshot("demo", join(dir, "scope"), join(dir, "cache"));

    expect(snapshot?.changedFiles.map((f) => f.path)).toEqual(["a.txt"]);
    expect(snapshot?.missingFiles.map((f) => f.path)).toEqual(["b.txt"]);
    expect(buildMemoryPrompt(snapshot!)).toContain("Changed since last run: 1");
  });

  test("normalizes checked paths to scope-relative files only", () => {
    expect(normalizeCheckedPath("/repo/infra", "compose/dev.yml")).toBe("compose/dev.yml");
    expect(normalizeCheckedPath("/repo/infra", "../README.md")).toBeNull();
    expect(normalizeCheckedPath("/repo/infra", "/repo/infra/compose/dev.yml")).toBe("compose/dev.yml");
    expect(normalizeCheckedPath("/repo/infra", "")).toBeNull();
  });
});
