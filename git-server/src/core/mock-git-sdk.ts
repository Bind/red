import type {
  CommitBuilder,
  CommitDiffRange,
  CommitDiffResult,
  CreateCommitOptions,
  CreateCommitResult,
  CreateRepoOptions,
  GitStorageAdapter,
  ListFilesResult,
  RefInfo,
  RemoteUrlOptions,
  RemoteUrlResult,
  Repo,
  RepoInfo,
} from "./api";

export interface MockGitSdkOptions {
  publicUrl: string;
  defaultOwner: string;
}

export class MockGitSdk implements GitStorageAdapter {
  readonly name = "git-sdk-mock";
  readonly capabilities = {
    createCommit: true,
    getRemoteUrl: true,
    getCommitDiff: true,
    ephemeralBranches: true,
    baseRepoSync: true,
    normalGitPush: true,
  } as const;

  constructor(private readonly options: MockGitSdkOptions) {}

  async createRepo(options: CreateRepoOptions): Promise<Repo> {
    return new MockGitSdkRepo(this.options, {
      id: `${options.owner ?? this.options.defaultOwner}/${options.name}`,
      owner: options.owner ?? this.options.defaultOwner,
      name: options.name,
      defaultBranch: options.defaultBranch ?? "main",
      visibility: options.visibility ?? "private",
      ephemeral: options.ephemeral ?? false,
      baseRepo: options.baseRepo,
    });
  }

  async getRepo(id: string): Promise<Repo | null> {
    const [owner, name] = id.split("/", 2);
    if (!owner || !name) return null;
    return new MockGitSdkRepo(this.options, {
      id,
      owner,
      name,
      defaultBranch: "main",
      visibility: "private",
      ephemeral: false,
    });
  }

  async listRepos(): Promise<RepoInfo[]> {
    return [];
  }
}

class MockGitSdkRepo implements Repo {
  constructor(
    private readonly adapterOptions: MockGitSdkOptions,
    private readonly repoInfo: RepoInfo
  ) {}

  async info(): Promise<RepoInfo> {
    return this.repoInfo;
  }

  async getRemoteUrl(options: RemoteUrlOptions): Promise<RemoteUrlResult> {
    const expiresAt =
      options.ttlSeconds === undefined
        ? undefined
        : new Date(Date.now() + options.ttlSeconds * 1000).toISOString();
    const token = `${options.actorId}-token`;
    const encodedRepoId = this.repoInfo.id.replace("/", "%2F");
    const url = `${this.adapterOptions.publicUrl}/git/${encodedRepoId}?token=${token}`;

    return {
      url,
      fetchUrl: url,
      pushUrl: url,
      protocol: "smart-http",
      expiresAt,
    };
  }

  createCommit(options: CreateCommitOptions): CommitBuilder {
    const mutations: { op: "put" | "delete"; path: string; content?: string }[] = [];

    return {
      put(path: string, content: string) {
        mutations.push({ op: "put", path, content });
        return this;
      },
      delete(path: string) {
        mutations.push({ op: "delete", path });
        return this;
      },
      async send(): Promise<CreateCommitResult> {
        void mutations;
        return {
          commitSha: "git-sdk-placeholder-commit",
          branch: options.branch,
        };
      },
    };
  }

  async getCommitDiff(range: CommitDiffRange): Promise<CommitDiffResult> {
    return {
      baseRef: range.baseRef,
      headRef: range.headRef,
      files: range.pathPrefix
        ? [{ path: `${range.pathPrefix}/placeholder.ts`, status: "modified" }]
        : [{ path: "README.md", status: "modified" }],
    };
  }

  async listRefs(): Promise<RefInfo[]> {
    return [{ name: `refs/heads/${this.repoInfo.defaultBranch}`, sha: "git-sdk-main-sha" }];
  }

  async resolveRef(name: string): Promise<RefInfo | null> {
    return { name, sha: "git-sdk-resolved-sha" };
  }

  async createBranch(name: string, fromSha: string): Promise<RefInfo> {
    return { name: `refs/heads/${name}`, sha: fromSha };
  }

  async updateBranch(name: string, toSha: string, _expectedOldSha?: string): Promise<RefInfo> {
    return { name: `refs/heads/${name}`, sha: toSha };
  }

  async listFiles(_ref?: string): Promise<ListFilesResult> {
    return { paths: ["README.md"] };
  }
}
