import type {
  ChangeRecord,
  ChangeStore,
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
} from "./index";

export interface GittyAdapterOptions {
  baseUrl: string;
  defaultOwner: string;
}

export class GittyAdapter implements GitStorageAdapter {
  readonly name = "gitty";
  readonly capabilities = {
    createCommit: true,
    getRemoteUrl: true,
    getCommitDiff: true,
    ephemeralBranches: true,
    baseRepoSync: true,
    normalGitPush: true,
  } as const;

  constructor(private readonly options: GittyAdapterOptions) {}

  async createRepo(options: CreateRepoOptions): Promise<Repo> {
    return new GittyRepo(this.options, {
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
    return new GittyRepo(this.options, {
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

class GittyRepo implements Repo {
  constructor(
    private readonly adapterOptions: GittyAdapterOptions,
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
    const url = `${this.adapterOptions.baseUrl}/git/${encodedRepoId}?token=${token}`;

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
          commitSha: "gitty-placeholder-commit",
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
    return [{ name: `refs/heads/${this.repoInfo.defaultBranch}`, sha: "gitty-main-sha" }];
  }

  async resolveRef(name: string): Promise<RefInfo | null> {
    return { name, sha: "gitty-resolved-sha" };
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

export class InMemoryChangeStore implements ChangeStore {
  private readonly records = new Map<string, ChangeRecord>();
  private nextId = 1;

  async create(change: Omit<ChangeRecord, "id">): Promise<ChangeRecord> {
    const record = { ...change, id: `change-${this.nextId++}` };
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<ChangeRecord | null> {
    return this.records.get(id) ?? null;
  }
}
