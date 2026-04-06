import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BranchInfo, CommitInfo, DiffStats, FileStats, RepoInfo } from "../types";
import type { RepositoryProvider } from "./repository-provider";

export interface LocalGitProviderConfig {
  reposRoot: string;
}

export class LocalGitProvider implements RepositoryProvider {
  constructor(private config: LocalGitProviderConfig) {}

  async compareDiff(owner: string, repo: string, base: string, head: string): Promise<DiffStats> {
    const repoPath = this.resolveRepoPath(owner, repo);
    const output = this.runGit(repoPath, ["diff", "--numstat", "--find-renames", `${base}...${head}`]);
    const files: FileStats[] = [];

    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const [rawAdditions = "0", rawDeletions = "0", rawPath = ""] = line.split("\t");
      if (!rawPath) continue;
      const additions = rawAdditions === "-" ? 0 : parseInt(rawAdditions, 10);
      const deletions = rawDeletions === "-" ? 0 : parseInt(rawDeletions, 10);
      const normalized = normalizeDiffPath(rawPath);
      files.push({
        filename: normalized.filename,
        additions: Number.isFinite(additions) ? additions : 0,
        deletions: Number.isFinite(deletions) ? deletions : 0,
        status: normalized.status,
      });
    }

    return {
      files_changed: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files,
    };
  }

  async getDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    const repoPath = this.resolveRepoPath(owner, repo);
    return this.runGit(repoPath, ["diff", "--find-renames", `${base}...${head}`]);
  }

  async getFileContent(
    owner: string,
    repo: string,
    filepath: string,
    ref: string
  ): Promise<string | null> {
    const repoPath = this.resolveRepoPath(owner, repo);
    try {
      return this.runGit(repoPath, ["show", `${ref}:${filepath}`]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("exists on disk, but not in") ||
        message.includes("path") ||
        message.includes("invalid object name")
      ) {
        return null;
      }
      throw err;
    }
  }

  async listCommits(owner: string, repo: string, ref: string = "main", limit: number = 20): Promise<CommitInfo[]> {
    const repoPath = this.resolveRepoPath(owner, repo);
    const output = this.runGit(repoPath, [
      "log",
      "--format=%H\t%s\t%an\t%ae\t%cI",
      `-${Math.max(1, Math.trunc(limit))}`,
      ref,
    ]);

    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha = "", message = "", authorName = "", authorEmail = "", timestamp = ""] = line.split("\t");
        return {
          sha,
          message,
          author_name: authorName || null,
          author_email: authorEmail || null,
          timestamp: timestamp || null,
        };
      })
      .filter((commit) => commit.sha);
  }

  async listRepos(): Promise<RepoInfo[]> {
    if (!existsSync(this.config.reposRoot)) return [];

    const repos: RepoInfo[] = [];
    let id = 1;

    for (const owner of readdirSync(this.config.reposRoot, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      const ownerPath = join(this.config.reposRoot, owner.name);
      for (const repoDir of readdirSync(ownerPath, { withFileTypes: true })) {
        if (!repoDir.isDirectory()) continue;
        const repoPath = join(ownerPath, repoDir.name);
        if (!isGitRepository(repoPath)) continue;
        const repoName = repoDir.name.endsWith(".git")
          ? repoDir.name.slice(0, -4)
          : repoDir.name;
        repos.push({
          id: id++,
          name: repoName,
          full_name: `${owner.name}/${repoName}`,
          default_branch: this.getDefaultBranch(repoPath),
        });
      }
    }

    return repos;
  }

  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const repoPath = this.resolveRepoPath(owner, repo);
    return {
      id: 0,
      name: repo,
      full_name: `${owner}/${repo}`,
      default_branch: this.getDefaultBranch(repoPath),
    };
  }

  async listBranches(owner: string, repo: string): Promise<BranchInfo[]> {
    const repoPath = this.resolveRepoPath(owner, repo);
    const defaultBranch = this.getDefaultBranch(repoPath);
    const output = this.runGit(repoPath, [
      "for-each-ref",
      "--format=%(refname:short)\t%(objectname)\t%(contents:subject)\t%(committerdate:iso-strict)",
      "refs/heads",
    ]);

    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name = "", id = "", message = "", timestamp = ""] = line.split("\t");
        return {
          name,
          commit: {
            id,
            message,
            timestamp: timestamp || new Date(0).toISOString(),
          },
          protected: name === defaultBranch,
        };
      });
  }

  private resolveRepoPath(owner: string, repo: string): string {
    const direct = join(this.config.reposRoot, owner, repo);
    if (isGitRepository(direct)) return direct;

    const bare = `${direct}.git`;
    if (isGitRepository(bare)) return bare;

    throw new Error(`Local git repo not found for ${owner}/${repo} under ${this.config.reposRoot}`);
  }

  private getDefaultBranch(repoPath: string): string {
    return this.runGit(repoPath, ["symbolic-ref", "--short", "HEAD"]).replace(/^heads\//, "");
  }

  private runGit(repoPath: string | undefined, args: string[]): string {
    const command = repoPath
      ? (isGitRepository(repoPath) && repoPath.endsWith(".git")
        ? ["git", "--git-dir", repoPath, ...args]
        : ["git", ...args])
      : ["git", ...args];
    const result = Bun.spawnSync(command, {
      cwd: repoPath && !repoPath.endsWith(".git") ? repoPath : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString().trim() || `git ${args[0]} failed`);
    }
    return result.stdout.toString().trim();
  }
}

function normalizeDiffPath(rawPath: string): { filename: string; status: FileStats["status"] } {
  if (rawPath.includes("=>")) {
    const target = rawPath.split("=>").pop()?.replace(/[{}]/g, "").trim() || rawPath;
    return { filename: target, status: "renamed" };
  }
  return { filename: rawPath, status: "modified" };
}

function isGitRepository(path: string): boolean {
  return existsSync(path) && existsSync(join(path, "HEAD"));
}
