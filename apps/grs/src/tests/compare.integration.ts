import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { startDevGitServer, runCommand } from "../core/dev-stack";
import { buildRemoteUrl } from "./http-test-helpers";

interface CompareResponse {
  base: string;
  head: string;
  files_changed: number;
  additions: number;
  deletions: number;
  files: Array<{
    filename: string;
    additions: number;
    deletions: number;
    status: "added" | "modified" | "deleted" | "renamed";
  }>;
}

describe("git server compare integration", () => {
  test("returns stable filenames for nested file diffs", async () => {
    const server = await startDevGitServer();
    const runId = randomUUID().slice(0, 8);
    const repoDir = await mkdtemp(join(tmpdir(), "red-gitty-compare-"));

    try {
      const repoName = `compare-repo-${runId}`;
      const repoId = `red/${repoName}`;
      const remote = buildRemoteUrl(server.publicUrl, server.authTokenSecret, repoId, "compare-test", "write");

      await runCommand("git", ["init"], { cwd: repoDir });
      await runCommand("git", ["config", "user.name", "compare test"], { cwd: repoDir });
      await runCommand("git", ["config", "user.email", "compare@red.local"], { cwd: repoDir });
      await Bun.write(join(repoDir, "README.md"), "# compare repo\n");
      await runCommand("git", ["add", "README.md"], { cwd: repoDir });
      await runCommand("git", ["commit", "-m", "seed repo"], { cwd: repoDir });
      await runCommand("git", ["branch", "-M", "main"], { cwd: repoDir });
      await runCommand("git", ["remote", "add", "origin", remote.pushUrl], { cwd: repoDir });
      await runCommand("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

      const mainRef = (await runCommand("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout;

      await runCommand("git", ["checkout", "-b", "feature/nested-diff"], { cwd: repoDir });
      await mkdir(join(repoDir, "src"), { recursive: true });
      await mkdir(join(repoDir, "docs"), { recursive: true });
      await Bun.write(join(repoDir, "src", "feature.ts"), 'export const mode = "nested";\n');
      await Bun.write(join(repoDir, "docs", "guide.md"), "# nested doc\n");
      await runCommand("git", ["add", "src/feature.ts", "docs/guide.md"], { cwd: repoDir });
      await runCommand("git", ["commit", "-m", "add nested files"], { cwd: repoDir });
      await runCommand("git", ["push", "origin", "HEAD:refs/heads/feature/nested-diff"], { cwd: repoDir });

      const featureRef = (await runCommand("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout;

      const compareUrl = new URL(`/api/repos/red/${repoName}/compare`, server.publicUrl);
      compareUrl.searchParams.set("base", mainRef);
      compareUrl.searchParams.set("head", featureRef);

      const response = await fetch(compareUrl, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${server.adminUsername}:${server.adminPassword}`).toString("base64")}`,
        },
      });
      expect(response.ok).toBe(true);

      const result = await response.json() as CompareResponse;
      const filenames = result.files.map((file) => file.filename).sort();

      expect(result.base).toBe(mainRef);
      expect(result.head).toBe(featureRef);
      expect(result.files_changed).toBe(2);
      expect(filenames).toEqual(["docs/guide.md", "src/feature.ts"]);
      expect(result.files.every((file) => !file.filename.includes("\n"))).toBe(true);
      expect(result.files.every((file) => !file.filename.includes('"'))).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await server.stop();
    }
  }, 120_000);
});
