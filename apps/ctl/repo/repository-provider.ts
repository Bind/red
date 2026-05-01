import type { BranchInfo, CommitInfo, DiffStats, RepoInfo } from "../types";

export interface RepositoryProvider {
  compareDiff(
    owner: string,
    repo: string,
    base: string,
    head: string,
    requestId?: string,
  ): Promise<DiffStats>;
  getDiff(owner: string, repo: string, base: string, head: string, requestId?: string): Promise<string>;
  getCommitDiff?(owner: string, repo: string, sha: string, requestId?: string): Promise<string>;
  getFileContent(
    owner: string,
    repo: string,
    filepath: string,
    ref: string,
    requestId?: string,
  ): Promise<string | null>;
  listCommits?(
    owner: string,
    repo: string,
    ref?: string,
    limit?: number,
    requestId?: string,
  ): Promise<CommitInfo[]>;
  listRepos?(): Promise<RepoInfo[]>;
  getRepo?(owner: string, repo: string, requestId?: string): Promise<RepoInfo>;
  listBranches?(owner: string, repo: string, requestId?: string): Promise<BranchInfo[]>;
}
