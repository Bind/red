import type { BranchInfo, CommitInfo, DiffStats, RepoInfo } from "../types";
import type { RepositoryProvider } from "./repository-provider";

export interface GitServerHttpRepositoryProviderOptions {
  baseUrl: string;
  username?: string;
  password?: string;
}

interface GitServerRepoPayload {
  id?: string | number;
  name: string;
  full_name: string;
  default_branch: string;
}

interface GitServerComparePayload extends DiffStats {
  patch?: string;
}

export class GitServerHttpRepositoryProvider implements RepositoryProvider {
  constructor(private readonly options: GitServerHttpRepositoryProviderOptions) {}

  async compareDiff(owner: string, repo: string, base: string, head: string): Promise<DiffStats> {
    const result = await this.readJson<GitServerComparePayload>(
      this.repoUrl(owner, repo, `/compare?${new URLSearchParams({ base, head }).toString()}`)
    );
    return {
      files_changed: result.files_changed,
      additions: result.additions,
      deletions: result.deletions,
      files: result.files,
    };
  }

  async getDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    const result = await this.readJson<GitServerComparePayload>(
      this.repoUrl(owner, repo, `/compare?${new URLSearchParams({ base, head, patch: "1" }).toString()}`)
    );
    return result.patch ?? "";
  }

  async getCommitDiff(owner: string, repo: string, sha: string): Promise<string> {
    const result = await this.readJson<{ patch?: string }>(
      this.repoUrl(owner, repo, `/commits/${encodeURIComponent(sha)}/diff`)
    );
    return result.patch ?? "";
  }

  async getFileContent(owner: string, repo: string, filepath: string, ref: string): Promise<string | null> {
    const payload = await this.readJson<{ content: string | null }>(
      this.repoUrl(owner, repo, `/file?${new URLSearchParams({ path: filepath, ref }).toString()}`)
    );
    return payload.content;
  }

  async listCommits(owner: string, repo: string, ref?: string, limit?: number): Promise<CommitInfo[]> {
    const params = new URLSearchParams();
    if (ref) params.set("ref", ref);
    if (limit != null) params.set("limit", String(limit));
    return this.readJson<CommitInfo[]>(this.repoUrl(owner, repo, `/commits?${params.toString()}`));
  }

  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const payload = await this.readJson<GitServerRepoPayload>(this.repoUrl(owner, repo));
    return {
      id: typeof payload.id === "number" ? payload.id : 0,
      name: payload.name,
      full_name: payload.full_name,
      default_branch: payload.default_branch,
    };
  }

  async listBranches(owner: string, repo: string): Promise<BranchInfo[]> {
    return this.readJson<BranchInfo[]>(this.repoUrl(owner, repo, "/branches"));
  }

  private repoUrl(owner: string, repo: string, suffix = "") {
    return new URL(`/api/repos/${owner}/${repo}${suffix}`, this.options.baseUrl).toString();
  }

  private async readJson<T>(url: string): Promise<T> {
    const headers = new Headers();
    if (this.options.username || this.options.password) {
      const encoded = Buffer.from(`${this.options.username ?? ""}:${this.options.password ?? ""}`).toString("base64");
      headers.set("Authorization", `Basic ${encoded}`);
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(body || `git-server request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}
