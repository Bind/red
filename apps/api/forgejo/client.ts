import type {
  CommitStatusState,
  ForgejoBranch,
  ForgejoCommitStatus,
  ForgejoCreateUserOptions,
  ForgejoPR,
  ForgejoRepo,
  ForgejoSSHKey,
  ForgejoToken,
  ForgejoUser,
  DiffStats,
  FileStats,
} from "../types";

export interface ForgejoClientConfig {
  baseUrl: string;
  token: string;
}

export class ForgejoClient {
  private baseUrl: string;
  private token: string;

  constructor(config: ForgejoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
  }

  private async request<T>(
    path: string,
    opts: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `token ${this.token}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ForgejoAPIError(res.status, path, body);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /** Get the diff between two commits as a unified diff string. */
  async getDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    const url = `${this.baseUrl}/api/v1/repos/${owner}/${repo}/git/commits/${head}.diff`;
    const res = await fetch(url, {
      headers: { Authorization: `token ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ForgejoAPIError(res.status, `/repos/${owner}/${repo}/git/commits/${head}.diff`, body);
    }
    return res.text();
  }

  /** Compare two refs and get diff stats. */
  async compareDiff(
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<DiffStats> {
    const data = await this.request<{
      total_commits: number;
      files: Array<{
        filename: string;
        additions: number;
        deletions: number;
        status: string;
      }>;
    }>(`/repos/${owner}/${repo}/compare/${base}...${head}`);

    const files: FileStats[] = (data.files ?? []).map((f) => ({
      filename: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      status: mapFileStatus(f.status),
    }));

    return {
      files_changed: files.length,
      additions: files.reduce((s, f) => s + f.additions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      files,
    };
  }

  /** Read a file from a specific ref (used to get .redc/policy.yaml from base branch). */
  async getFileContent(
    owner: string,
    repo: string,
    filepath: string,
    ref: string
  ): Promise<string | null> {
    try {
      const data = await this.request<{ content: string; encoding: string }>(
        `/repos/${owner}/${repo}/contents/${filepath}?ref=${encodeURIComponent(ref)}`
      );
      if (data.encoding === "base64") {
        return atob(data.content);
      }
      return data.content;
    } catch (err) {
      if (err instanceof ForgejoAPIError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Set a commit status (pending/success/failure/error). */
  async setCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    status: ForgejoCommitStatus
  ): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/statuses/${sha}`, {
      method: "POST",
      body: JSON.stringify(status),
    });
  }

  /** Merge a pull request. */
  async mergePR(
    owner: string,
    repo: string,
    prNumber: number,
    method: "merge" | "rebase" | "squash" = "merge"
  ): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: "POST",
      body: JSON.stringify({ Do: method }),
    });
  }

  /** Create a pull request. */
  async createPR(
    owner: string,
    repo: string,
    opts: { title: string; head: string; base: string; body?: string }
  ): Promise<ForgejoPR> {
    return this.request<ForgejoPR>(`/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  /** Get a pull request by number. */
  async getPR(owner: string, repo: string, prNumber: number): Promise<ForgejoPR> {
    return this.request<ForgejoPR>(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  }

  /** List open PRs for a branch. */
  async listPRsForBranch(
    owner: string,
    repo: string,
    branch: string
  ): Promise<ForgejoPR[]> {
    return this.request<ForgejoPR[]>(
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(branch)}`
    );
  }

  /** List all branches for a repo. */
  async listBranches(owner: string, repo: string): Promise<ForgejoBranch[]> {
    return this.request<ForgejoBranch[]>(`/repos/${owner}/${repo}/branches`);
  }

  /** Get repo info (to find default branch name). */
  async getRepo(owner: string, repo: string): Promise<ForgejoRepo> {
    return this.request<ForgejoRepo>(`/repos/${owner}/${repo}`);
  }

  /** List repos accessible by the current token. */
  async listRepos(): Promise<ForgejoRepo[]> {
    return this.request<ForgejoRepo[]>("/user/repos?limit=50");
  }

  // ── Admin methods (used by bootstrap) ──────────────────

  /** Create a Forgejo user via admin API. Returns null if user already exists. */
  async createUser(opts: ForgejoCreateUserOptions): Promise<ForgejoUser | null> {
    try {
      return await this.request<ForgejoUser>("/admin/users", {
        method: "POST",
        body: JSON.stringify(opts),
      });
    } catch (err) {
      if (err instanceof ForgejoAPIError && (err.status === 409 || err.status === 422)) {
        return null;
      }
      throw err;
    }
  }

  /** Upload an SSH key for a user. Returns null if key already exists. */
  async uploadSSHKey(
    username: string,
    title: string,
    key: string
  ): Promise<ForgejoSSHKey | null> {
    try {
      return await this.request<ForgejoSSHKey>(
        `/admin/users/${encodeURIComponent(username)}/keys`,
        {
          method: "POST",
          body: JSON.stringify({ title, key }),
        }
      );
    } catch (err) {
      if (err instanceof ForgejoAPIError && (err.status === 409 || err.status === 422)) {
        return null;
      }
      throw err;
    }
  }

  /** Create a repo owned by a user via admin API. Returns null if repo already exists. */
  async createUserRepo(
    username: string,
    opts: { name: string; auto_init?: boolean; default_branch?: string }
  ): Promise<ForgejoRepo | null> {
    try {
      return await this.request<ForgejoRepo>(
        `/admin/users/${encodeURIComponent(username)}/repos`,
        {
          method: "POST",
          body: JSON.stringify(opts),
        }
      );
    } catch (err) {
      if (err instanceof ForgejoAPIError && (err.status === 409 || err.status === 422)) {
        return null;
      }
      throw err;
    }
  }

  /** Create an API token for a user. Returns null if token name already exists. */
  async createUserToken(
    username: string,
    name: string
  ): Promise<ForgejoToken | null> {
    try {
      return await this.request<ForgejoToken>(
        `/users/${encodeURIComponent(username)}/tokens`,
        {
          method: "POST",
          body: JSON.stringify({ name, scopes: ["all"] }),
        }
      );
    } catch (err) {
      if (err instanceof ForgejoAPIError && (err.status === 409 || err.status === 422)) {
        return null;
      }
      throw err;
    }
  }

  /** Create a webhook on a repo. Returns null if webhook already exists. */
  async createWebhook(
    owner: string,
    repo: string,
    opts: { url: string; secret: string; events: string[] }
  ): Promise<unknown> {
    try {
      return await this.request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
        {
          method: "POST",
          body: JSON.stringify({
            type: "forgejo",
            active: true,
            config: {
              url: opts.url,
              content_type: "json",
              secret: opts.secret,
            },
            events: opts.events,
          }),
        }
      );
    } catch (err) {
      if (err instanceof ForgejoAPIError && (err.status === 409 || err.status === 422)) {
        return null;
      }
      throw err;
    }
  }
}

export class ForgejoAPIError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string
  ) {
    super(`Forgejo API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = "ForgejoAPIError";
  }
}

function mapFileStatus(status: string): FileStats["status"] {
  switch (status) {
    case "added":
      return "added";
    case "deleted":
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}
