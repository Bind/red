export type RepoVisibility = "private" | "internal" | "public";
export type RemoteProtocol = "smart-http";

export interface BaseRepoInput {
  owner: string;
  name: string;
  defaultBranch: string;
  provider?: "github" | "git";
}

export interface CreateRepoOptions {
  name: string;
  owner?: string;
  defaultBranch?: string;
  visibility?: RepoVisibility;
  baseRepo?: BaseRepoInput;
  ephemeral?: boolean;
}

export interface RepoInfo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  visibility: RepoVisibility;
  ephemeral: boolean;
  baseRepo?: BaseRepoInput;
}

export interface RemoteUrlOptions {
  actorId: string;
  ttlSeconds?: number;
  access?: "read" | "write";
}

export interface RemoteUrlResult {
  url: string;
  fetchUrl: string;
  pushUrl: string;
  protocol: RemoteProtocol;
  expiresAt?: string;
  username?: string;
  password?: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitDiffRange {
  baseRef: string;
  headRef: string;
  pathPrefix?: string;
  includePatch?: boolean;
}

export interface CommitDiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CommitDiffResult {
  baseRef: string;
  headRef: string;
  files: CommitDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
  patch?: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  timestamp?: string;
}

export interface Repo {
  info(): Promise<RepoInfo>;
  getRemoteUrl(options: RemoteUrlOptions): Promise<RemoteUrlResult>;
  getCommitDiff(range: CommitDiffRange): Promise<CommitDiffResult>;
  readTextFile(options: { ref: string; path: string }): Promise<string | null>;
  listCommits(options?: { ref?: string; limit?: number }): Promise<CommitInfo[]>;
  listBranches(): Promise<Array<{
    name: string;
    sha: string;
    message?: string;
    timestamp?: string;
    protected?: boolean;
  }>>;
}

export interface GitStorage {
  getRepo(id: string): Promise<Repo | null>;
  getRepoByName(owner: string, name: string): Promise<Repo | null>;
}

export interface ChangeRecord {
  id: string;
  repoId: string;
  baseRef: string;
  headRef: string;
  status: "draft" | "in_review" | "accepted" | "rejected" | "merged";
  pathPrefix?: string;
  headRepoId?: string;
}

export interface ChangeStore {
  create(change: Omit<ChangeRecord, "id">): Promise<ChangeRecord>;
  get(id: string): Promise<ChangeRecord | null>;
}

export interface GitStorageAdapter extends GitStorage {
  readonly name: string;
  readonly capabilities: {
    getRemoteUrl: boolean;
    getCommitDiff: boolean;
    ephemeralBranches: boolean;
    baseRepoSync: boolean;
    normalGitPush: boolean;
  };
}

export function describeExperimentArchitecture() {
  return {
    api: {
      client: "GitStorage",
      repo: "Repo",
      coreMethods: [
        "getRepo",
        "getRepoByName",
        "getRemoteUrl",
        "getCommitDiff",
        "readTextFile",
        "listBranches",
        "listCommits",
      ],
    },
    separation: {
      storage: [
        "git remotes",
        "diffs",
        "history reads",
        "file reads",
      ],
      product: [
        "redc review/change lifecycle",
        "policy",
        "audit trail",
        "permissions",
      ],
    },
    principle: "match code.storage semantics at the SDK layer; keep redc review semantics above it",
  };
}
