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

  async getRepoByName(owner: string, name: string): Promise<Repo | null> {
    return this.getRepo(`${owner}/${name}`);
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
    const filePath = range.pathPrefix ? `${range.pathPrefix}/placeholder.ts` : "README.md";
    return {
      baseRef: range.baseRef,
      headRef: range.headRef,
      files: [
        {
          path: filePath,
          status: "modified",
          additions: 4,
          deletions: 1,
          patch: range.includePatch ? `diff --git a/${filePath} b/${filePath}\n@@ -1 +1,4 @@\n-old\n+new\n` : undefined,
        },
      ],
      totalAdditions: 4,
      totalDeletions: 1,
      patch: range.includePatch ? `diff --git a/${filePath} b/${filePath}\n@@ -1 +1,4 @@\n-old\n+new\n` : undefined,
    };
  }

  async readTextFile(options: { ref: string; path: string }): Promise<string | null> {
    void options.ref;
    if (options.path === "missing.txt") return null;
    return `mock contents for ${options.path}\n`;
  }

  async listRefs(): Promise<RefInfo[]> {
    return [
      {
        name: `refs/heads/${this.repoInfo.defaultBranch}`,
        sha: "git-sdk-main-sha",
        message: "mock main commit",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ];
  }

  async listBranches(): Promise<Array<RefInfo & { protected?: boolean }>> {
    return [
      {
        name: this.repoInfo.defaultBranch,
        sha: "git-sdk-main-sha",
        message: "mock main commit",
        timestamp: "2026-01-01T00:00:00Z",
        protected: false,
      },
    ];
  }

  async resolveRef(name: string): Promise<RefInfo | null> {
    return {
      name: name.startsWith("refs/") ? name : `refs/heads/${name}`,
      sha: "git-sdk-resolved-sha",
      message: "mock resolved commit",
      timestamp: "2026-01-01T00:00:00Z",
    };
  }

  async createBranch(name: string, fromSha: string): Promise<RefInfo> {
    return {
      name: `refs/heads/${name}`,
      sha: fromSha,
      message: "mock branch commit",
      timestamp: "2026-01-01T00:00:00Z",
    };
  }

  async updateBranch(name: string, toSha: string, _expectedOldSha?: string): Promise<RefInfo> {
    return {
      name: `refs/heads/${name}`,
      sha: toSha,
      message: "mock branch commit",
      timestamp: "2026-01-01T00:00:00Z",
    };
  }

  async listFiles(_ref?: string): Promise<ListFilesResult> {
    return { paths: ["README.md"] };
  }
}
