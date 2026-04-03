export type RepoVisibility = "private" | "internal" | "public";
export type RemoteProtocol = "smart-http";

export interface BaseRepoInput {
  owner: string;
  name: string;
  defaultBranch: string;
  provider?: "github" | "forgejo" | "git";
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

export interface CreateCommitOptions {
  branch: string;
  message: string;
  author: CommitAuthor;
  parentSha?: string;
}

export interface CreateCommitResult {
  commitSha: string;
  branch: string;
}

export interface CommitDiffRange {
  baseRef: string;
  headRef: string;
  pathPrefix?: string;
}

export interface CommitDiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface CommitDiffResult {
  baseRef: string;
  headRef: string;
  files: CommitDiffFile[];
}

export interface RefInfo {
  name: string;
  sha: string;
}

export interface ListFilesResult {
  paths: string[];
}

export interface CommitBuilder {
  put(path: string, content: string): CommitBuilder;
  delete(path: string): CommitBuilder;
  send(): Promise<CreateCommitResult>;
}

export interface Repo {
  info(): Promise<RepoInfo>;
  getRemoteUrl(options: RemoteUrlOptions): Promise<RemoteUrlResult>;
  createCommit(options: CreateCommitOptions): CommitBuilder;
  getCommitDiff(range: CommitDiffRange): Promise<CommitDiffResult>;
  listRefs(): Promise<RefInfo[]>;
  resolveRef(name: string): Promise<RefInfo | null>;
  createBranch(name: string, fromSha: string): Promise<RefInfo>;
  updateBranch(name: string, toSha: string, expectedOldSha?: string): Promise<RefInfo>;
  listFiles(ref?: string): Promise<ListFilesResult>;
}

export interface GitStorage {
  createRepo(options: CreateRepoOptions): Promise<Repo>;
  getRepo(id: string): Promise<Repo | null>;
  listRepos(): Promise<RepoInfo[]>;
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
    createCommit: boolean;
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
        "createRepo",
        "getRepo",
        "getRemoteUrl",
        "createCommit",
        "getCommitDiff",
        "listRefs",
        "resolveRef",
      ],
    },
    separation: {
      storage: [
        "repo lifecycle",
        "git remotes",
        "direct commits",
        "ref resolution",
        "diffs",
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
