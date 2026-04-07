import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { startDevGitServer, runCommand } from "../core/dev-stack";
import { GitSdk } from "../core/git-sdk";

const maybeIntegrationTest = process.env.GIT_SERVER_RUN_INTEGRATION === "1" ? test : test.skip;

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
  maybeIntegrationTest("returns stable filenames for nested file diffs", async () => {
    const server = await startDevGitServer();
    const runId = randomUUID().slice(0, 8);
    const repoDir = await mkdtemp(join(tmpdir(), "redc-gitty-compare-"));

    try {
      const store = new GitSdk({
        publicUrl: server.publicUrl,
        defaultOwner: "redc",
        authTokenSecret: server.authTokenSecret,
      });

      const repo = await store.createRepo({
        owner: "redc",
        name: `compare-repo-${runId}`,
        defaultBranch: "main",
        visibility: "private",
      });
      const repoInfo = await repo.info();

      const remote = await repo.getRemoteUrl({
        actorId: "compare-test",
        ttlSeconds: 300,
        access: "write",
      });

      await runCommand("git", ["init"], { cwd: repoDir });
      await runCommand("git", ["config", "user.name", "compare test"], { cwd: repoDir });
      await runCommand("git", ["config", "user.email", "compare@redc.local"], { cwd: repoDir });
      await Bun.write(join(repoDir, "README.md"), "# compare repo\n");
      await runCommand("git", ["add", "README.md"], { cwd: repoDir });
      await runCommand("git", ["commit", "-m", "seed repo"], { cwd: repoDir });
      await runCommand("git", ["branch", "-M", "main"], { cwd: repoDir });
      await runCommand("git", ["remote", "add", "origin", remote.pushUrl], { cwd: repoDir });
      await runCommand("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

      const mainRef = await repo.resolveRef("refs/heads/main");
      expect(mainRef).not.toBeNull();

      await runCommand("git", ["checkout", "-b", "feature/nested-diff"], { cwd: repoDir });
      await mkdir(join(repoDir, "src"), { recursive: true });
      await mkdir(join(repoDir, "docs"), { recursive: true });
      await Bun.write(join(repoDir, "src", "feature.ts"), 'export const mode = "nested";\n');
      await Bun.write(join(repoDir, "docs", "guide.md"), "# nested doc\n");
      await runCommand("git", ["add", "src/feature.ts", "docs/guide.md"], { cwd: repoDir });
      await runCommand("git", ["commit", "-m", "add nested files"], { cwd: repoDir });
      await runCommand("git", ["push", "origin", "HEAD:refs/heads/feature/nested-diff"], { cwd: repoDir });

      const featureRef = await repo.resolveRef("refs/heads/feature/nested-diff");
      expect(featureRef).not.toBeNull();

      const compareUrl = new URL(`/api/repos/${repoInfo.owner}/${repoInfo.name}/compare`, server.publicUrl);
      compareUrl.searchParams.set("base", mainRef!.sha);
      compareUrl.searchParams.set("head", featureRef!.sha);

      const response = await fetch(compareUrl, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${server.adminUsername}:${server.adminPassword}`).toString("base64")}`,
        },
      });
      expect(response.ok).toBe(true);

      const result = await response.json() as CompareResponse;
      const filenames = result.files.map((file) => file.filename).sort();

      expect(result.base).toBe(mainRef!.sha);
      expect(result.head).toBe(featureRef!.sha);
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
