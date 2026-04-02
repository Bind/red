import type {
  CommitStatusState,
  DiffStats,
  ForgejoBranch,
  ForgejoCommitStatus,
  ForgejoPR,
  ForgejoRepo,
} from "../types";

export interface RepoProvider {
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
  setCommitStatus?(
    owner: string,
    repo: string,
    sha: string,
    status: CommitStatus
  ): Promise<void>;
  listPRsForBranch?(
    owner: string,
    repo: string,
    branch: string
  ): Promise<ForgejoPR[]>;
  createPR?(
    owner: string,
    repo: string,
    opts: { title: string; head: string; base: string; body?: string }
  ): Promise<ForgejoPR>;
  mergePR?(
    owner: string,
    repo: string,
    prNumber: number,
    method?: "merge" | "rebase" | "squash"
  ): Promise<void>;
  listRepos?(): Promise<ForgejoRepo[]>;
  getRepo?(owner: string, repo: string): Promise<ForgejoRepo>;
  listBranches?(owner: string, repo: string): Promise<ForgejoBranch[]>;
}

export type CommitStatus = ForgejoCommitStatus;
export type CommitStatusResult = CommitStatusState;
