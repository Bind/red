import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitProvider } from "./local-git-provider";

let rootDir: string;
let workDir: string;
let bareDir: string;
let provider: LocalGitProvider;

async function git(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args[0]} failed`);
  }
  return stdout.trim();
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "redc-local-git-"));
  const ownerDir = join(rootDir, "owner");
  bareDir = join(ownerDir, "repo.git");
  workDir = join(rootDir, "work");

  await Bun.write(join(rootDir, ".gitkeep"), "");
  await git(["init", "--bare", bareDir]);
  await git(["clone", bareDir, workDir]);
  await git(["config", "user.name", "redc-test"], workDir);
  await git(["config", "user.email", "redc@example.com"], workDir);
  await Bun.write(join(workDir, "README.md"), "base\n");
  await git(["add", "README.md"], workDir);
  await git(["commit", "-m", "init"], workDir);
  await git(["push", "origin", "HEAD:main"], workDir);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], bareDir);
  await git(["checkout", "-b", "feature/test"], workDir);
  await Bun.write(join(workDir, "README.md"), "base\nfeature\n");
  await git(["add", "README.md"], workDir);
  await git(["commit", "-m", "feature"], workDir);
  await git(["push", "origin", "HEAD"], workDir);

  provider = new LocalGitProvider({ reposRoot: rootDir });
});

afterEach(async () => {
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
  }
});

describe("LocalGitProvider", () => {
  test("compares refs, reads diffs, files, repos, and branches", async () => {
    const stats = await provider.compareDiff("owner", "repo", "main", "feature/test");
    expect(stats.files_changed).toBe(1);
    expect(stats.additions).toBe(1);

    const diff = await provider.getDiff("owner", "repo", "main", "feature/test");
    expect(diff).toContain("+feature");

    const content = await provider.getFileContent("owner", "repo", "README.md", "feature/test");
    expect(content).toContain("feature");

    const repos = await provider.listRepos?.();
    expect(repos?.map((repo) => repo.full_name)).toContain("owner/repo");

    const repo = await provider.getRepo?.("owner", "repo");
    expect(repo?.default_branch).toBe("main");

    const branches = await provider.listBranches?.("owner", "repo");
    expect(branches?.some((branch) => branch.name === "main")).toBe(true);
    expect(branches?.some((branch) => branch.name === "feature/test")).toBe(true);
  });
});
