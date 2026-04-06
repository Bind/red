export interface HostedRepoConfig {
  repoId: string;
  apiBaseUrl: string;
  readmePath: string;
}

export interface HostedRepoBranch {
  name: string;
  sha: string;
  message: string;
  timestamp: string | null;
  protected: boolean;
}

export interface HostedRepoCommit {
  sha: string;
  message: string;
  author_name: string | null;
  author_email: string | null;
  timestamp: string | null;
}

export interface HostedRepoSnapshot {
  repo: {
    owner: string;
    name: string;
    full_name: string;
    default_branch: string;
    visibility: "private" | "internal" | "public";
  };
  readme: {
    path: string;
    content: string;
  } | null;
  branches: HostedRepoBranch[];
  commits: HostedRepoCommit[];
  access: {
    actor_id: string;
    mode: "read";
    token_ttl_seconds: number;
  };
  availability: {
    reachable: boolean;
    error: string | null;
  };
  fetched_at: string;
}

export interface HostedRepoReader {
  readSnapshot(): Promise<HostedRepoSnapshot>;
}

type FetchImpl = (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;

interface RepoRecord {
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  visibility: "private" | "internal" | "public";
}

interface BranchRecord {
  name: string;
  commit: {
    id: string;
    message: string;
    timestamp: string;
  };
  protected?: boolean;
}

interface CommitRecord {
  sha: string;
  message: string;
  author_name: string | null;
  author_email: string | null;
  timestamp: string | null;
}

function splitRepoId(repoId: string) {
  const [owner, name] = repoId.split("/", 2).map((value) => value.trim());
  if (!owner || !name) {
    throw new Error(`Invalid hosted repo id: ${repoId}`);
  }
  return { owner, name };
}

async function readJson<T>(fetchImpl: FetchImpl, url: string): Promise<T> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `Request failed: ${response.status}`));
  }
  return response.json() as Promise<T>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHostedRepoReader(
  config: HostedRepoConfig,
  fetchImpl: FetchImpl = fetch,
): HostedRepoReader {
  const { owner, name } = splitRepoId(config.repoId);
  const repoUrl = new URL(`/api/repos/${owner}/${name}`, config.apiBaseUrl).toString();
  const branchesUrl = new URL(`/api/repos/${owner}/${name}/branches`, config.apiBaseUrl).toString();
  const commitsUrl = new URL(`/api/repos/${owner}/${name}/commits?limit=20`, config.apiBaseUrl).toString();
  const readmeUrl = new URL(
    `/api/repos/${owner}/${name}/file?path=${encodeURIComponent(config.readmePath)}`,
    config.apiBaseUrl,
  ).toString();

  return {
    async readSnapshot() {
      try {
        const [repo, branches, commits, readme] = await Promise.all([
          readJson<RepoRecord>(fetchImpl, repoUrl),
          readJson<BranchRecord[]>(fetchImpl, branchesUrl),
          readJson<CommitRecord[]>(fetchImpl, commitsUrl),
          readJson<{ path: string; content: string | null }>(fetchImpl, readmeUrl),
        ]);

        return {
          repo,
          readme: readme.content == null ? null : readme,
          branches: branches
            .map((branch) => ({
              name: branch.name,
              sha: branch.commit.id,
              message: branch.commit.message,
              timestamp: branch.commit.timestamp ?? null,
              protected: Boolean(branch.protected ?? branch.name === repo.default_branch),
            }))
            .sort((left, right) => {
              if (left.protected !== right.protected) return left.protected ? -1 : 1;
              return left.name.localeCompare(right.name);
            }),
          commits,
          access: {
            actor_id: "redc-bff-hosted-repo",
            mode: "read",
            token_ttl_seconds: 300,
          },
          availability: {
            reachable: true,
            error: null,
          },
          fetched_at: new Date().toISOString(),
        };
      } catch (error) {
        return {
          repo: {
            owner,
            name,
            full_name: config.repoId,
            default_branch: "main",
            visibility: "private",
          },
          readme: null,
          branches: [],
          commits: [],
          access: {
            actor_id: "redc-bff-hosted-repo",
            mode: "read",
            token_ttl_seconds: 300,
          },
          availability: {
            reachable: false,
            error: toErrorMessage(error),
          },
          fetched_at: new Date().toISOString(),
        };
      }
    },
  };
}
