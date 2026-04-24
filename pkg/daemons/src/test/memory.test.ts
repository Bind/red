import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryPrompt,
  collectCheckedFiles,
  collectScopeInventory,
  createDaemonMemoryStore,
  loadMemorySnapshot,
  normalizeCheckedPath,
  saveMemoryRecord,
} from "../memory";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "daemons-memory-"));
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "daemon@example.com"], dir);
  await git(["config", "user.name", "Daemon Test"], dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("memory", () => {
  test("saves and reloads checked-file fingerprints", async () => {
    await mkdir(join(dir, "scope"));
    await writeFile(join(dir, "scope", "a.txt"), "one\n");
    await commitAll("initial");
    const checkedFiles = await collectCheckedFiles(join(dir, "scope"), ["a.txt"]);

    await saveMemoryRecord(
      {
        version: 3,
        daemonContractVersion: 1,
        daemon: "demo",
        scopeRoot: join(dir, "scope"),
        repoRoot: dir,
        repoId: "test/repo",
        commit: null,
        baseCommit: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        tracked: {},
        lastRun: {
          summary: "ok",
          findings: [],
          checkedFiles,
          fileInventory: checkedFiles,
        },
      },
      join(dir, "scope"),
      join(dir, "cache"),
    );

    const snapshot = await loadMemorySnapshot("demo", join(dir, "scope"), join(dir, "cache"));
    expect(snapshot).not.toBeNull();
    expect(snapshot?.record.commit).toBe(await headCommit());
    expect(snapshot?.unchangedFiles.map((f) => f.path)).toEqual(["a.txt"]);
    expect(snapshot?.changedFiles).toHaveLength(0);
    expect(snapshot?.missingFiles).toHaveLength(0);
  });

  test("detects changed and missing files", async () => {
    await mkdir(join(dir, "scope"));
    await writeFile(join(dir, "scope", "a.txt"), "one\n");
    await writeFile(join(dir, "scope", "b.txt"), "two\n");
    await commitAll("initial");
    const checkedFiles = await collectCheckedFiles(join(dir, "scope"), ["a.txt", "b.txt"]);

    await saveMemoryRecord(
      {
        version: 3,
        daemonContractVersion: 1,
        daemon: "demo",
        scopeRoot: join(dir, "scope"),
        repoRoot: dir,
        repoId: "test/repo",
        commit: null,
        baseCommit: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        tracked: {},
        lastRun: {
          summary: "ok",
          findings: [{ invariant: "x", status: "ok" }],
          checkedFiles,
          fileInventory: checkedFiles,
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
    expect(buildMemoryPrompt(snapshot!)).toContain("Changed since snapshot: 1");
  });

  test("detects new files from scope inventory", async () => {
    await mkdir(join(dir, "scope"));
    await writeFile(join(dir, "scope", "a.txt"), "one\n");
    await commitAll("initial");
    const inventory = await collectScopeInventory(join(dir, "scope"));

    await saveMemoryRecord(
      {
        version: 3,
        daemonContractVersion: 1,
        daemon: "demo",
        scopeRoot: join(dir, "scope"),
        repoRoot: dir,
        repoId: "test/repo",
        commit: null,
        baseCommit: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        tracked: {},
        lastRun: {
          summary: "ok",
          findings: [],
          checkedFiles: [],
          fileInventory: inventory,
        },
      },
      join(dir, "scope"),
      join(dir, "cache"),
    );

    await writeFile(join(dir, "scope", "new.txt"), "new\n");
    const snapshot = await loadMemorySnapshot("demo", join(dir, "scope"), join(dir, "cache"));

    expect(snapshot?.newFiles.map((f) => f.path)).toEqual(["new.txt"]);
    expect(snapshot?.changedScopeFiles).toEqual([]);
    expect(buildMemoryPrompt(snapshot!)).toContain("New since snapshot: 1");
    expect(buildMemoryPrompt(snapshot!)).toContain("New files since snapshot:");
  });

  test("invalidates tracked subjects when a dependency file changes", async () => {
    await mkdir(join(dir, "scope"));
    await writeFile(join(dir, "scope", "contract.ts"), "v1\n");
    await commitAll("initial");
    const inventory = await collectScopeInventory(join(dir, "scope"));
    const store = await createDaemonMemoryStore("demo", join(dir, "scope"), join(dir, "cache"));

    await store.record({
      subject: "service:obs:health",
      fingerprint: "tracked-v1",
      fact: { status: "ok" },
      depends_on: ["contract.ts"],
      checked_at: "2026-01-01T00:00:00.000Z",
      source_run_id: "run_a",
    });

    await saveMemoryRecord(
      {
        version: 3,
        daemonContractVersion: 1,
        daemon: "demo",
        scopeRoot: join(dir, "scope"),
        repoRoot: dir,
        repoId: "test/repo",
        commit: null,
        baseCommit: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        tracked: store.snapshot().tracked,
        lastRun: {
          summary: "ok",
          findings: [],
          checkedFiles: inventory,
          fileInventory: inventory,
        },
      },
      join(dir, "scope"),
      join(dir, "cache"),
    );

    await writeFile(join(dir, "scope", "contract.ts"), "v2\n");
    const snapshot = await loadMemorySnapshot("demo", join(dir, "scope"), join(dir, "cache"));

    expect(snapshot?.staleTrackedSubjects).toEqual(["service:obs:health"]);
    expect(snapshot?.changedScopeFiles.map((f) => f.path)).toEqual(["contract.ts"]);
    expect(snapshot?.record.tracked["service:obs:health"]).toBeUndefined();
    expect(buildMemoryPrompt(snapshot!)).toContain("Tracked subjects invalidated since snapshot:");
  });

  test("reuses nearest ancestor snapshot across commits", async () => {
    await mkdir(join(dir, "scope"));
    await writeFile(join(dir, "scope", "a.txt"), "one\n");
    await commitAll("initial");
    const firstCommit = await headCommit();
    const inventory = await collectScopeInventory(join(dir, "scope"));

    await saveMemoryRecord(
      {
        version: 3,
        daemonContractVersion: 1,
        daemon: "demo",
        scopeRoot: join(dir, "scope"),
        repoRoot: dir,
        repoId: "test/repo",
        commit: null,
        baseCommit: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        tracked: {},
        lastRun: {
          summary: "ok",
          findings: [],
          checkedFiles: [],
          fileInventory: inventory,
        },
      },
      join(dir, "scope"),
      join(dir, "cache"),
    );

    await writeFile(join(dir, "scope", "b.txt"), "two\n");
    await commitAll("add b");

    const snapshot = await loadMemorySnapshot("demo", join(dir, "scope"), join(dir, "cache"));
    expect(snapshot?.record.commit).toBe(firstCommit);
    expect(snapshot?.currentCommit).toBe(await headCommit());
    expect(snapshot?.newFiles.map((f) => f.path)).toEqual(["b.txt"]);
  });

  test("normalizes checked paths to scope-relative files only", () => {
    expect(normalizeCheckedPath("/repo/infra", "compose/dev.yml")).toBe("compose/dev.yml");
    expect(normalizeCheckedPath("/repo/infra", "../README.md")).toBeNull();
    expect(normalizeCheckedPath("/repo/infra", "/repo/infra/compose/dev.yml")).toBe("compose/dev.yml");
    expect(normalizeCheckedPath("/repo/infra", "")).toBeNull();
  });
});

async function commitAll(message: string): Promise<void> {
  await git(["add", "."], dir);
  await git(["commit", "-m", message], dir);
}

async function headCommit(): Promise<string> {
  const output = await git(["rev-parse", "HEAD"], dir);
  return output.trim();
}

async function git(args: string[], cwd: string): Promise<string> {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  const proc = Bun.spawn({
    cmd: ["git", "-C", cwd, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout.trim();
}
