import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDirectoryContents, resolveSandboxCwd } from "./sandbox-fs";

describe("resolveSandboxCwd", () => {
  test("keeps cwd inside the destination workspace", () => {
    expect(resolveSandboxCwd("/repo", "/workspace", "/repo/src")).toBe("/workspace/src");
    expect(resolveSandboxCwd("/repo", "/workspace")).toBe("/workspace");
  });

  test("rejects cwd values outside the source root", () => {
    expect(() => resolveSandboxCwd("/repo", "/workspace", "/tmp/outside")).toThrow(
      "sandbox cwd must stay inside sourceRoot",
    );
  });
});

describe("copyDirectoryContents", () => {
  test("skips git and node_modules content while copying tracked files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "sandbox-fs-test-"));
    const sourceRoot = join(rootDir, "source");
    const destinationRoot = join(rootDir, "dest");

    try {
      await mkdir(join(sourceRoot, ".git"), { recursive: true });
      await mkdir(join(sourceRoot, "node_modules", "left-pad"), { recursive: true });
      await mkdir(join(sourceRoot, "src"), { recursive: true });
      await mkdir(destinationRoot, { recursive: true });

      await writeFile(join(sourceRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(sourceRoot, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
      await writeFile(join(sourceRoot, "src", "index.ts"), "export const ok = true;\n");

      await copyDirectoryContents(sourceRoot, destinationRoot);

      expect(await readFile(join(destinationRoot, "src", "index.ts"), "utf8")).toContain("ok");
      expect(existsSync(join(destinationRoot, ".git"))).toBe(false);
      expect(existsSync(join(destinationRoot, "node_modules"))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
