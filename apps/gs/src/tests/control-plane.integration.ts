import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { startDevGitServer, runCommand, runCommandWithRetry, type StartedDevGitServer } from "../core/dev-stack";
import { buildRemoteUrl, fetchJson } from "./http-test-helpers";

interface RepoPayload {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  visibility: "private";
}

interface BranchPayload {
  name: string;
  commit: {
    id: string;
    message: string;
    timestamp: string;
  };
  protected: boolean;
}

interface CommitPayload {
  sha: string;
  message: string;
  author_name: string | null;
  author_email: string | null;
  timestamp: string | null;
}

interface FilePayload {
  path: string;
  ref: string;
  content: string | null;
}

interface ComparePayload {
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
  patch?: string;
}

async function createRepoWithHistory(server: StartedDevGitServer, repoName: string) {
  const repoInfo = {
    id: `redc/${repoName}`,
    owner: "redc",
    name: repoName,
  };
  const remote = buildRemoteUrl(server.publicUrl, server.authTokenSecret, repoInfo.id, "control-plane-test", "write");

  const repoDir = await mkdtemp(join(tmpdir(), "redc-gitty-control-plane-"));

  await runCommand("git", ["init"], { cwd: repoDir });
  await runCommand("git", ["config", "user.name", "control plane test"], { cwd: repoDir });
  await runCommand("git", ["config", "user.email", "control-plane@redc.local"], { cwd: repoDir });
  await Bun.write(join(repoDir, "README.md"), "# native control plane\n");
  await runCommand("git", ["add", "README.md"], { cwd: repoDir });
  await runCommand("git", ["commit", "-m", "seed repo"], { cwd: repoDir });
  await runCommand("git", ["branch", "-M", "main"], { cwd: repoDir });
  await runCommand("git", ["remote", "add", "origin", remote.pushUrl], { cwd: repoDir });
  await runCommandWithRetry("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

  await runCommand("git", ["checkout", "-b", "feature/native-control-plane"], { cwd: repoDir });
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "docs"), { recursive: true });
  await Bun.write(join(repoDir, "src", "feature.ts"), 'export const mode = "native-control-plane";\n');
  await Bun.write(join(repoDir, "docs", "guide.md"), "# guide\n");
  await runCommand("git", ["add", "src/feature.ts", "docs/guide.md"], { cwd: repoDir });
  await runCommand("git", ["commit", "-m", "add nested control plane files"], { cwd: repoDir });
  await runCommandWithRetry("git", ["push", "origin", "HEAD:refs/heads/feature/native-control-plane"], { cwd: repoDir });

  const mainRef = {
    sha: (await runCommand("git", ["-C", repoDir, "rev-parse", "main"])).stdout,
  };
  const featureRef = {
    sha: (await runCommand("git", ["-C", repoDir, "rev-parse", "HEAD"])).stdout,
  };

  return {
    repoInfo,
    repoDir,
    mainRef,
    featureRef,
  };
}

function repoUrl(server: StartedDevGitServer, owner: string, name: string, suffix = "") {
  return new URL(`/api/repos/${owner}/${name}${suffix}`, server.publicUrl);
}

describe("native control-plane integration", () => {
  test("serves repo, branch, commit, file, and compare endpoints with stable data", async () => {
    const server = await startDevGitServer();
    const runId = randomUUID().slice(0, 8);
    const { repoInfo, repoDir, mainRef, featureRef } = await createRepoWithHistory(server, `cp-repo-${runId}`);

    try {
      const auth = {
        username: server.adminUsername,
        password: server.adminPassword,
      };

      const repoResult = await fetchJson<RepoPayload>(repoUrl(server, repoInfo.owner, repoInfo.name), auth);
      expect(repoResult.response.status).toBe(200);
      expect(repoResult.json?.full_name).toBe(repoInfo.id);
      expect(repoResult.json?.default_branch).toBe("main");

      const branchesResult = await fetchJson<BranchPayload[]>(repoUrl(server, repoInfo.owner, repoInfo.name, "/branches"), auth);
      expect(branchesResult.response.status).toBe(200);
      expect(branchesResult.json?.some((branch) => branch.name === "main" && branch.protected)).toBe(true);
      expect(branchesResult.json?.some((branch) => branch.name === "feature/native-control-plane" && branch.commit.id === featureRef.sha)).toBe(true);

      const commitsResult = await fetchJson<CommitPayload[]>(
        repoUrl(
          server,
          repoInfo.owner,
          repoInfo.name,
          `/commits?${new URLSearchParams({ ref: featureRef.sha, limit: "2" }).toString()}`,
        ),
        auth,
      );
      expect(commitsResult.response.status).toBe(200);
      expect(commitsResult.json?.length).toBe(2);
      expect(commitsResult.json?.[0]?.sha).toBe(featureRef.sha);
      expect(commitsResult.json?.[0]?.message).toBe("add nested control plane files");

      const fileResult = await fetchJson<FilePayload>(
        repoUrl(
          server,
          repoInfo.owner,
          repoInfo.name,
          `/file?${new URLSearchParams({ path: "src/feature.ts", ref: featureRef.sha }).toString()}`,
        ),
        auth,
      );
      expect(fileResult.response.status).toBe(200);
      expect(fileResult.json?.content).toBe('export const mode = "native-control-plane";\n');

      const missingFileResult = await fetchJson<FilePayload>(
        repoUrl(
          server,
          repoInfo.owner,
          repoInfo.name,
          `/file?${new URLSearchParams({ path: "missing.ts", ref: featureRef.sha }).toString()}`,
        ),
        auth,
      );
      expect(missingFileResult.response.status).toBe(200);
      expect(missingFileResult.json?.content).toBeNull();

      const compareResult = await fetchJson<ComparePayload>(
        repoUrl(
          server,
          repoInfo.owner,
          repoInfo.name,
          `/compare?${new URLSearchParams({ base: mainRef.sha, head: featureRef.sha }).toString()}`,
        ),
        auth,
      );
      expect(compareResult.response.status).toBe(200);
      expect(compareResult.json?.base).toBe(mainRef.sha);
      expect(compareResult.json?.head).toBe(featureRef.sha);
      expect(compareResult.json?.files_changed).toBe(2);
      expect(compareResult.json?.files.map((file) => file.filename).sort()).toEqual(["docs/guide.md", "src/feature.ts"]);
      expect(compareResult.json?.files.every((file) => !file.filename.includes("\n"))).toBe(true);
      expect(compareResult.json?.additions).toBeGreaterThan(0);

      const commitDiffResult = await fetchJson<ComparePayload>(
        repoUrl(server, repoInfo.owner, repoInfo.name, `/commits/${featureRef.sha}/diff`),
        auth,
      );
      expect(commitDiffResult.response.status).toBe(200);
      expect(commitDiffResult.json?.base).toBe(mainRef.sha);
      expect(commitDiffResult.json?.head).toBe(featureRef.sha);
      expect(commitDiffResult.json?.patch).toContain("diff --git");
      expect(commitDiffResult.json?.patch).toContain("+++ b/docs/guide.md");
      expect(commitDiffResult.json?.patch).toContain("+++ b/src/feature.ts");

      const badRefResult = await fetchJson<{ error: string }>(
        repoUrl(
          server,
          repoInfo.owner,
          repoInfo.name,
          `/commits?${new URLSearchParams({ ref: "refs/heads/does-not-exist", limit: "1" }).toString()}`,
        ),
        auth,
      );
      expect(badRefResult.response.status).toBe(500);
      expect(badRefResult.json?.error).toBe("NotFound");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await server.stop();
    }
  }, 120_000);

  test("preserves control-plane reads across git-server restarts", async () => {
    let server = await startDevGitServer();
    const runId = randomUUID().slice(0, 8);
    const { repoInfo, repoDir, featureRef } = await createRepoWithHistory(server, `cp-restart-${runId}`);

    try {
      await server.stop();
      server = await startDevGitServer();

      const auth = {
        username: server.adminUsername,
        password: server.adminPassword,
      };

      const branchesResult = await fetchJson<BranchPayload[]>(repoUrl(server, repoInfo.owner, repoInfo.name, "/branches"), auth);
      expect(branchesResult.response.status).toBe(200);
      expect(branchesResult.json?.some((branch) => branch.name === "feature/native-control-plane" && branch.commit.id === featureRef.sha)).toBe(true);

      const fileResult = await fetchJson<FilePayload>(
        repoUrl(
          server,
          repoInfo.owner,
          repoInfo.name,
          `/file?${new URLSearchParams({ path: "src/feature.ts", ref: featureRef.sha }).toString()}`,
        ),
        auth,
      );
      expect(fileResult.response.status).toBe(200);
      expect(fileResult.json?.content).toBe('export const mode = "native-control-plane";\n');

      const lsRemote = await runCommandWithRetry("git", [
        "ls-remote",
        `http://${server.adminUsername}:${server.adminPassword}@127.0.0.1:9080/${repoInfo.owner}/${repoInfo.name}.git`,
      ]);
      expect(lsRemote.stdout).toContain(featureRef.sha);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await server.stop();
    }
  }, 120_000);
});
