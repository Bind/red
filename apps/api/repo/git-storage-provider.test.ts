import { describe, expect, test } from "bun:test";
import { MockGitSdk } from "../../../services/git-server/src/core/mock-git-sdk";
import { GitStorageRepositoryProvider } from "./git-storage-provider";

describe("GitStorageRepositoryProvider", () => {
  test("adapts diff, file, repo, and branch operations from git-server SDK", async () => {
    const provider = new GitStorageRepositoryProvider({
      storage: new MockGitSdk({
        publicUrl: "https://git.example.redc.internal",
        defaultOwner: "redc",
      }),
      knownRepos: ["redc/agent-scratch"],
      defaultBranch: "main",
    });

    const stats = await provider.compareDiff("redc", "agent-scratch", "refs/heads/main", "refs/heads/feature/demo");
    expect(stats.files_changed).toBe(1);
    expect(stats.additions).toBe(4);
    expect(stats.deletions).toBe(1);
    expect(stats.files[0]?.filename).toBe("README.md");

    const diff = await provider.getDiff("redc", "agent-scratch", "refs/heads/main", "refs/heads/feature/demo");
    expect(diff).toContain("diff --git");

    const content = await provider.getFileContent("redc", "agent-scratch", "README.md", "main");
    expect(content).toContain("README.md");

    const missing = await provider.getFileContent("redc", "agent-scratch", "missing.txt", "main");
    expect(missing).toBeNull();

    const repos = await provider.listRepos?.();
    expect(repos?.map((repo) => repo.full_name)).toContain("redc/agent-scratch");

    const repo = await provider.getRepo?.("redc", "agent-scratch");
    expect(repo?.default_branch).toBe("main");

    const branches = await provider.listBranches?.("redc", "agent-scratch");
    expect(branches?.some((branch) => branch.name === "main")).toBe(true);
    expect(branches?.[0]?.commit.message).toBeTruthy();
  });
});
