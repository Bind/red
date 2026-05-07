import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobStore } from "./blob-store";
import { harvestBureauOut } from "./harvest";

let storeDir: string;
let workspaceDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "bureau-harvest-store-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "bureau-harvest-ws-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
  await rm(workspaceDir, { recursive: true, force: true });
});

describe("harvestBureauOut", () => {
  test("returns an empty list when .bureau-out/ does not exist", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir: storeDir });

    const names = await harvestBureauOut({
      workspaceDir,
      sessionId: "ses-abc",
      store,
    });

    expect(names).toEqual([]);
  });

  test("writes each file in .bureau-out/ to the store under sessionId", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir: storeDir });
    const outDir = join(workspaceDir, ".bureau-out");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "summary.md"), "summary contents");
    await writeFile(join(outDir, "result.json"), '{"ok":true}');

    const names = await harvestBureauOut({
      workspaceDir,
      sessionId: "ses-abc",
      store,
    });

    expect(names.sort()).toEqual(["result.json", "summary.md"]);

    const summary = await store.get("ses-abc", "summary.md");
    expect(new TextDecoder().decode(summary?.bytes)).toBe("summary contents");

    const result = await store.get("ses-abc", "result.json");
    expect(new TextDecoder().decode(result?.bytes)).toBe('{"ok":true}');
  });

  test("preserves nested paths in .bureau-out/ as blob names", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir: storeDir });
    const outDir = join(workspaceDir, ".bureau-out");
    await mkdir(join(outDir, "diffs"), { recursive: true });
    await writeFile(join(outDir, "diffs", "auth.diff"), "diff contents");

    const names = await harvestBureauOut({
      workspaceDir,
      sessionId: "ses-abc",
      store,
    });

    expect(names).toEqual(["diffs/auth.diff"]);

    const blob = await store.get("ses-abc", "diffs/auth.diff");
    expect(new TextDecoder().decode(blob?.bytes)).toBe("diff contents");
  });
});
