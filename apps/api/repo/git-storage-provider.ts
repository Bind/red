import type { CommitDiffFile, GitStorage } from "../../gs/src/core/api";
import type { RepositoryProvider } from "./repository-provider";
import type { BranchInfo, CommitInfo, DiffStats, FileStats, RepoRecord, RepoInfo } from "../types";

export interface GitStorageRepositoryProviderOptions {
  storage: GitStorage;
  knownRepos?: string[];
  defaultBranch?: string;
  repoCatalog?: {
    listRepos(): Promise<RepoRecord[]>;
    getRepo(owner: string, repo: string): Promise<RepoRecord | null>;
  };
}

export class GitStorageRepositoryProvider implements RepositoryProvider {
  private readonly knownRepos: Set<string>;
  private readonly defaultBranch: string;

  constructor(private readonly options: GitStorageRepositoryProviderOptions) {
    this.knownRepos = new Set(options.knownRepos ?? []);
    this.defaultBranch = options.defaultBranch ?? "main";
  }

  async compareDiff(owner: string, repo: string, base: string, head: string): Promise<DiffStats> {
    const handle = await this.requireRepo(owner, repo);
    const diff = await handle.getCommitDiff({ baseRef: base, headRef: head });
    return {
      files_changed: diff.files.length,
      additions: diff.totalAdditions,
      deletions: diff.totalDeletions,
      files: diff.files.map(mapCommitDiffFile),
    };
  }

  async getDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    const handle = await this.requireRepo(owner, repo);
    const diff = await handle.getCommitDiff({ baseRef: base, headRef: head, includePatch: true });
    return diff.patch ?? "";
  }

  async getFileContent(
    owner: string,
    repo: string,
    filepath: string,
    ref: string
  ): Promise<string | null> {
    const handle = await this.requireRepo(owner, repo);
    return handle.readTextFile({ ref, path: filepath });
  }

  async listCommits(owner: string, repo: string, ref?: string, limit?: number): Promise<CommitInfo[]> {
    const handle = await this.requireRepo(owner, repo);
    const commits = await handle.listCommits({ ref, limit });
    return commits.map((commit) => ({
      sha: commit.sha,
      message: commit.message,
      author_name: commit.authorName ?? null,
      author_email: commit.authorEmail ?? null,
      timestamp: commit.timestamp ?? null,
    }));
  }

  async listRepos(): Promise<RepoInfo[]> {
    if (this.options.repoCatalog) {
      const catalog = await this.options.repoCatalog.listRepos();
      return catalog.map(mapRepoRecord);
    }

    const discovered = await this.options.storage.listRepos();
    if (discovered.length > 0) {
      return discovered.map((repo) => ({
        id: 0,
        name: repo.name,
        full_name: repo.id,
        default_branch: repo.defaultBranch,
      }));
    }

    return [...this.knownRepos]
      .filter((repoId) => repoId.includes("/"))
      .map((repoId, index) => {
        const [owner, name] = repoId.split("/", 2);
        return {
          id: index + 1,
          name,
          full_name: `${owner}/${name}`,
          default_branch: this.defaultBranch,
        };
      });
  }

  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const handle = await this.requireRepo(owner, repo);
    const info = await handle.info();
    return {
      id: 0,
      name: info.name,
      full_name: info.id,
      default_branch: info.defaultBranch,
    };
  }

  async listBranches(owner: string, repo: string): Promise<BranchInfo[]> {
    const handle = await this.requireRepo(owner, repo);
    const info = await handle.info();
    const branches = await handle.listBranches();
    return branches.map((branch) => ({
      name: branch.name,
      commit: {
        id: branch.sha,
        message: branch.message ?? "",
        timestamp: branch.timestamp ?? new Date(0).toISOString(),
      },
      protected: branch.protected ?? branch.name === info.defaultBranch,
    }));
  }

  private async requireRepo(owner: string, name: string) {
    const repo = await this.getOrRegisterRepo(owner, name);
    if (!repo) {
      throw new Error(`Git storage repo not found: ${owner}/${name}`);
    }
    return repo;
  }

  private async getOrRegisterRepo(owner: string, name: string) {
    const existing = await this.options.storage.getRepoByName(owner, name);
    if (existing) return existing;

    const catalogRecord = this.options.repoCatalog
      ? await this.options.repoCatalog.getRepo(owner, name)
      : null;
    if (catalogRecord) {
      return this.options.storage.createRepo({
        owner: catalogRecord.owner,
        name: catalogRecord.name,
        defaultBranch: catalogRecord.default_branch,
        visibility: catalogRecord.visibility,
      });
    }

    const repoId = `${owner}/${name}`;
    if (!this.knownRepos.has(repoId)) {
      return null;
    }

    return this.options.storage.createRepo({
      owner,
      name,
      defaultBranch: this.defaultBranch,
      visibility: "private",
    });
  }
}

function mapRepoRecord(record: RepoRecord): RepoInfo {
  return {
    id: record.id,
    name: record.name,
    full_name: record.full_name,
    default_branch: record.default_branch,
  };
}

function mapCommitDiffFile(file: CommitDiffFile): FileStats {
  return {
    filename: file.path,
    additions: file.additions,
    deletions: file.deletions,
    status: file.status,
  };
}
