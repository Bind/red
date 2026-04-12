import type {
  CommitDiffRange,
  CommitDiffResult,
  CommitInfo,
  GitStorageAdapter,
  RemoteUrlOptions,
  RemoteUrlResult,
  Repo,
  RepoInfo,
} from "./api";
import type { GitCredentialIssuer } from "./auth";
import { SharedSecretGitAuth } from "./auth";

export interface GitSdkOptions {
  publicUrl: string;
  defaultOwner: string;
  authTokenSecret?: string;
  credentialIssuer?: GitCredentialIssuer;
  controlPlaneBaseUrl?: string;
}

interface RepoPayload {
  id?: string;
  owner?: string;
  name: string;
  full_name?: string;
  default_branch: string;
  visibility?: RepoInfo["visibility"];
}

interface ComparePayload {
  base: string;
  head: string;
  additions: number;
  deletions: number;
  files: Array<{
    filename: string;
    additions: number;
    deletions: number;
    status: "added" | "modified" | "deleted" | "renamed";
  }>;
  patch?: string;
}

interface BranchPayload {
  name: string;
  commit: {
    id: string;
    message: string;
    timestamp: string;
  };
  protected: boolean;
}

interface CommitPayload {
  sha: string;
  message: string;
  author_name: string | null;
  author_email: string | null;
  timestamp: string | null;
}

interface FilePayload {
  content: string | null;
}

export class GitSdk implements GitStorageAdapter {
  readonly name = "git-sdk";
  readonly capabilities = {
    getRemoteUrl: true,
    getCommitDiff: true,
    ephemeralBranches: false,
    baseRepoSync: false,
    normalGitPush: true,
  } as const;

  constructor(private readonly options: GitSdkOptions) {}

  async getRepo(id: string): Promise<Repo | null> {
    const [owner, name] = id.split("/", 2);
    if (!owner || !name) return null;
    return this.getRepoByName(owner, name);
  }

  async getRepoByName(owner: string, name: string): Promise<Repo | null> {
    const repo = new GitSdkRepo(this.options, { owner, name });
    try {
      await repo.info();
      return repo;
    } catch {
      return null;
    }
  }
}

class GitSdkRepo implements Repo {
  constructor(
    private readonly options: GitSdkOptions,
    private readonly target: { owner: string; name: string },
  ) {}

  async info(): Promise<RepoInfo> {
    const payload = await this.readJson<RepoPayload>(this.repoPath());
    return {
      id: payload.id ?? payload.full_name ?? `${this.target.owner}/${this.target.name}`,
      owner: payload.owner ?? this.target.owner,
      name: payload.name,
      defaultBranch: payload.default_branch,
      visibility: payload.visibility ?? "private",
      ephemeral: false,
    };
  }

  async getRemoteUrl(options: RemoteUrlOptions): Promise<RemoteUrlResult> {
    const repoId = `${this.target.owner}/${this.target.name}`;
    const url = `${this.options.publicUrl.replace(/\/+$/, "")}/${this.target.owner}/${this.target.name}.git`;
    const access = options.access ?? "write";
    const issuer = this.options.credentialIssuer
      ?? (this.options.authTokenSecret ? new SharedSecretGitAuth({ tokenSecret: this.options.authTokenSecret }) : null);
    const credentials = issuer
      ? issuer.issueRepoCredentials({
          actorId: options.actorId,
          repoId,
          access,
          ttlSeconds: options.ttlSeconds ?? 3600,
        })
      : undefined;
    const authenticatedUrl = credentials ? addBasicAuth(url, credentials.username, credentials.password) : url;
    return {
      url: authenticatedUrl,
      fetchUrl: authenticatedUrl,
      pushUrl: authenticatedUrl,
      protocol: "smart-http",
      username: credentials?.username,
      password: credentials?.password,
    };
  }

  async getCommitDiff(range: CommitDiffRange): Promise<CommitDiffResult> {
    const params = new URLSearchParams({
      base: range.baseRef,
      head: range.headRef,
    });
    if (range.includePatch) params.set("patch", "1");
    const payload = await this.readJson<ComparePayload>(`${this.repoPath()}/compare?${params.toString()}`);
    const files = payload.files
      .filter((file) => !range.pathPrefix || file.filename.startsWith(range.pathPrefix))
      .map((file) => ({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      }));
    return {
      baseRef: payload.base,
      headRef: payload.head,
      files,
      totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
      patch: range.includePatch ? payload.patch : undefined,
    };
  }

  async readTextFile(options: { ref: string; path: string }): Promise<string | null> {
    const params = new URLSearchParams({
      path: options.path,
      ref: options.ref,
    });
    const payload = await this.readJson<FilePayload>(`${this.repoPath()}/file?${params.toString()}`);
    return payload.content;
  }

  async listCommits(options: { ref?: string; limit?: number } = {}): Promise<CommitInfo[]> {
    const params = new URLSearchParams();
    if (options.ref) params.set("ref", options.ref);
    if (options.limit != null) params.set("limit", String(options.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const payload = await this.readJson<CommitPayload[]>(`${this.repoPath()}/commits${suffix}`);
    return payload.map((commit) => ({
      sha: commit.sha,
      message: commit.message,
      authorName: commit.author_name ?? undefined,
      authorEmail: commit.author_email ?? undefined,
      timestamp: commit.timestamp ?? undefined,
    }));
  }

  async listBranches(): Promise<Array<{ name: string; sha: string; message?: string; timestamp?: string; protected?: boolean }>> {
    const payload = await this.readJson<BranchPayload[]>(`${this.repoPath()}/branches`);
    return payload.map((branch) => ({
      name: branch.name,
      sha: branch.commit.id,
      message: branch.commit.message || undefined,
      timestamp: branch.commit.timestamp || undefined,
      protected: branch.protected,
    }));
  }

  private repoPath() {
    return `/api/repos/${this.target.owner}/${this.target.name}`;
  }

  private async readJson<T>(path: string): Promise<T> {
    const url = new URL(path, this.options.controlPlaneBaseUrl ?? this.options.publicUrl).toString();
    const headers = new Headers();
    const issuer = this.options.credentialIssuer
      ?? (this.options.authTokenSecret ? new SharedSecretGitAuth({ tokenSecret: this.options.authTokenSecret }) : null);
    const credentials = issuer?.issueRepoCredentials({
      actorId: "git-sdk",
      repoId: `${this.target.owner}/${this.target.name}`,
      access: "read",
      ttlSeconds: 3600,
    });
    if (credentials) {
      headers.set("Authorization", `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`);
    }
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(body || `git-server request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}

function addBasicAuth(url: string, username: string, password: string) {
  const target = new URL(url);
  target.username = username;
  target.password = password;
  return target.toString();
}
