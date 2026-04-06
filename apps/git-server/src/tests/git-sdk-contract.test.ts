import { describe, expect, test } from "bun:test";
import { MockGitSdk } from "../core/mock-git-sdk";

describe("git-sdk contract", () => {
  test("supports stable lookup and canonical repo info", async () => {
    const store = new MockGitSdk({
      publicUrl: "https://git.example.redc.internal",
      defaultOwner: "redc",
    });

    const repo = await store.createRepo({
      owner: "redc",
      name: "skillz.sh",
      defaultBranch: "main",
    });

    const lookedUp = await store.getRepoByName("redc", "skillz.sh");

    expect((await repo.info()).id).toBe("redc/skillz.sh");
    expect(await lookedUp?.info()).toMatchObject({
      id: "redc/skillz.sh",
      owner: "redc",
      name: "skillz.sh",
      defaultBranch: "main",
    });
  });

  test("returns text file contents and null for missing files", async () => {
    const store = new MockGitSdk({
      publicUrl: "https://git.example.redc.internal",
      defaultOwner: "redc",
    });
    const repo = await store.createRepo({ name: "agent-scratch" });

    await expect(repo.readTextFile({ ref: "main", path: "README.md" })).resolves.toContain("README.md");
    await expect(repo.readTextFile({ ref: "main", path: "missing.txt" })).resolves.toBeNull();
  });

  test("returns enriched diff and branch metadata", async () => {
    const store = new MockGitSdk({
      publicUrl: "https://git.example.redc.internal",
      defaultOwner: "redc",
    });
    const repo = await store.createRepo({ name: "agent-scratch" });

    const diff = await repo.getCommitDiff({
      baseRef: "refs/heads/main",
      headRef: "refs/heads/feature/demo",
      includePatch: true,
    });
    const commits = await repo.listCommits({ limit: 2 });
    const branches = await repo.listBranches();
    const resolved = await repo.resolveRef("main");

    expect(diff.totalAdditions).toBeGreaterThan(0);
    expect(diff.totalDeletions).toBeGreaterThanOrEqual(0);
    expect(diff.patch).toContain("diff --git");
    expect(diff.files[0]?.patch).toContain("diff --git");
    expect(diff.files[0]).toMatchObject({
      additions: 4,
      deletions: 1,
    });
    expect(branches[0]).toMatchObject({
      name: "main",
      protected: false,
    });
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      sha: "git-sdk-main-sha",
    });
    expect(resolved).toMatchObject({
      name: "refs/heads/main",
    });
    expect(typeof resolved?.message).toBe("string");
    expect(typeof resolved?.timestamp).toBe("string");
  });
});
