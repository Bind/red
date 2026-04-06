import type { BranchInfo, DiffStats, RepoInfo } from "../types";

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
  listRepos?(): Promise<RepoInfo[]>;
  getRepo?(owner: string, repo: string): Promise<RepoInfo>;
  listBranches?(owner: string, repo: string): Promise<BranchInfo[]>;
}
