import { describe, expect, test } from "bun:test";
import { MockGitSdk } from "../../git-server/src/core/mock-git-sdk";
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

  test("rebuilds repo handles and listing from a durable repo catalog", async () => {
    const provider = new GitStorageRepositoryProvider({
      storage: new MockGitSdk({
        publicUrl: "https://git.example.redc.internal",
        defaultOwner: "redc",
      }),
      repoCatalog: {
        async listRepos() {
          return [
            {
              id: 1,
              org_id: "default",
              owner: "redc",
              name: "dashboard-demo",
              full_name: "redc/dashboard-demo",
              default_branch: "main",
              visibility: "private",
              created_by_subject: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          ];
        },
        async getRepo(owner: string, repo: string) {
          if (owner === "redc" && repo === "dashboard-demo") {
            return {
              id: 1,
              org_id: "default",
              owner,
              name: repo,
              full_name: `${owner}/${repo}`,
              default_branch: "main",
              visibility: "private",
              created_by_subject: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            };
          }
          return null;
        },
      },
    });

    const repos = await provider.listRepos?.();
    expect(repos?.map((repo) => repo.full_name)).toEqual(["redc/dashboard-demo"]);

    const repo = await provider.getRepo?.("redc", "dashboard-demo");
    expect(repo?.full_name).toBe("redc/dashboard-demo");
    expect(repo?.default_branch).toBe("main");
  });
});
