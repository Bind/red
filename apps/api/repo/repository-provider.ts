import type { BranchInfo, CommitInfo, DiffStats, RepoInfo } from "../types";

export interface RepositoryProvider {
  compareDiff(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<DiffStats>;
  getDiff(owner: string, repo: string, base: string, head: string): Promise<string>;
  getFileContent(
    owner: string,
    repo: string,
    filepath: string,
    ref: string
  ): Promise<string | null>;
  listCommits?(owner: string, repo: string, ref?: string, limit?: number): Promise<CommitInfo[]>;
  listRepos?(): Promise<RepoInfo[]>;
  getRepo?(owner: string, repo: string): Promise<RepoInfo>;
  listBranches?(owner: string, repo: string): Promise<BranchInfo[]>;
}
