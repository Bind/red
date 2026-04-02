export interface GitStorageExperimentOptions {
  namespace: string;
  signingKey?: string;
  endpoint?: string;
}

export interface RepoIdentity {
  id: string;
  defaultBranch: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CreateRepoInput {
  id: string;
  defaultBranch?: string;
}

export interface CreateCommitInput {
  targetBranch: string;
  commitMessage: string;
  author: CommitAuthor;
  baseBranch?: string;
  parentSha?: string;
}

export interface FileWrite {
  path: string;
  content: string;
}

export interface CommitResult {
  commitSha: string;
  branch: string;
}

export interface ListFilesResult {
  paths: string[];
}

export interface RemoteUrlOptions {
  ttlSeconds?: number;
}

export interface CommitBuilderExperiment {
  addFileFromString(path: string, content: string): CommitBuilderExperiment;
  deleteFile(path: string): CommitBuilderExperiment;
  send(): Promise<CommitResult>;
}

export interface GitRepoExperiment extends RepoIdentity {
  getRemoteURL(options?: RemoteUrlOptions): Promise<string>;
  listFiles(ref?: string): Promise<ListFilesResult>;
  createCommit(input: CreateCommitInput): CommitBuilderExperiment;
}

export interface GitStorageExperiment {
  createRepo(input: CreateRepoInput): Promise<GitRepoExperiment>;
  findRepo(id: string): Promise<GitRepoExperiment | null>;
  listRepos(): Promise<RepoIdentity[]>;
}

export function describeExperimentApi() {
  return {
    client: "GitStorageExperiment",
    repository: "GitRepoExperiment",
    flows: [
      "create repo",
      "discover repo",
      "mint authenticated remote URL",
      "read files",
      "create direct commit",
    ],
  };
}
