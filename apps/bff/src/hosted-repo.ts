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
  readSnapshot(options?: { requestId?: string }): Promise<HostedRepoSnapshot>;
}

type FetchImpl = (input: RequestInfo | URL | Request, init?: RequestInit) => Promise<Response>;

const HOSTED_REPO_OPTIONAL_TIMEOUT_MS = 8_000;

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

export function splitHostedRepoId(repoId: string) {
  const [owner, name] = repoId.split("/", 2).map((value) => value.trim());
  if (!owner || !name) {
    throw new Error(`Invalid hosted repo id: ${repoId}`);
  }
  return { owner, name };
}

function requestHeaders(requestId?: string): HeadersInit | undefined {
  if (!requestId) return undefined;
  return { "x-request-id": requestId };
}

async function readJson<T>(fetchImpl: FetchImpl, url: string, requestId?: string): Promise<T> {
  const response = await fetchImpl(url, {
    headers: requestHeaders(requestId),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => `Request failed: ${response.status}`));
  }
  return response.json() as Promise<T>;
}

async function readJsonWithTimeout<T>(
  fetchImpl: FetchImpl,
  url: string,
  timeoutMs: number,
  requestId?: string,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    signal,
    headers: requestHeaders(requestId),
  });
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
  const { owner, name } = splitHostedRepoId(config.repoId);
  const repoUrl = new URL(`/api/repos/${owner}/${name}`, config.apiBaseUrl).toString();
  const branchesUrl = new URL(`/api/repos/${owner}/${name}/branches`, config.apiBaseUrl).toString();
  const commitsUrl = new URL(`/api/repos/${owner}/${name}/commits?limit=20`, config.apiBaseUrl).toString();
  const readmeUrl = new URL(
    `/api/repos/${owner}/${name}/file?path=${encodeURIComponent(config.readmePath)}`,
    config.apiBaseUrl,
  ).toString();

  return {
    async readSnapshot(options = {}) {
      const requestId = options.requestId;
      try {
        const repo = await readJson<RepoRecord>(fetchImpl, repoUrl, requestId);

        const [branchesResult, commitsResult, readmeResult] = await Promise.allSettled([
          readJsonWithTimeout<BranchRecord[]>(
            fetchImpl,
            branchesUrl,
            HOSTED_REPO_OPTIONAL_TIMEOUT_MS,
            requestId,
          ),
          readJsonWithTimeout<CommitRecord[]>(
            fetchImpl,
            commitsUrl,
            HOSTED_REPO_OPTIONAL_TIMEOUT_MS,
            requestId,
          ),
          readJsonWithTimeout<{ path: string; content: string | null }>(
            fetchImpl,
            readmeUrl,
            HOSTED_REPO_OPTIONAL_TIMEOUT_MS,
            requestId,
          ),
        ]);

        const branches = branchesResult.status === "fulfilled" ? branchesResult.value : [];
        const commits = commitsResult.status === "fulfilled" ? commitsResult.value : [];
        const readme =
          readmeResult.status === "fulfilled" && readmeResult.value.content != null
            ? {
                path: readmeResult.value.path,
                content: readmeResult.value.content,
              }
            : null;

        const partialFailures = [
          branchesResult.status === "rejected" ? `branches: ${toErrorMessage(branchesResult.reason)}` : null,
          commitsResult.status === "rejected" ? `commits: ${toErrorMessage(commitsResult.reason)}` : null,
          readmeResult.status === "rejected" ? `readme: ${toErrorMessage(readmeResult.reason)}` : null,
        ].filter((value): value is string => Boolean(value));

        return {
          repo,
          readme,
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
            actor_id: "red-bff-hosted-repo",
            mode: "read",
            token_ttl_seconds: 300,
          },
          availability: {
            reachable: true,
            error: partialFailures.length > 0 ? partialFailures.join("; ") : null,
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
            actor_id: "red-bff-hosted-repo",
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
