import type {
  CommitStatusState,
  ForgejoCommitStatus,
  ForgejoPR,
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
