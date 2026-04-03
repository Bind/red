import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CommitBuilder,
  CommitDiffFile,
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
import { runCommand } from "./dev-stack";

export interface GitSdkOptions {
  publicUrl: string;
  defaultOwner: string;
  authTokenSecret?: string;
}

export class GitSdk implements GitStorageAdapter {
  readonly name = "git-sdk";
  readonly capabilities = {
    createCommit: true,
    getRemoteUrl: true,
    getCommitDiff: true,
    ephemeralBranches: false,
    baseRepoSync: false,
    normalGitPush: true,
  } as const;
  private readonly repos = new Map<string, RepoInfo>();

  constructor(private readonly options: GitSdkOptions) {}

  async createRepo(options: CreateRepoOptions): Promise<Repo> {
    const repoInfo = buildRepoInfo(options, this.options.defaultOwner);
    this.repos.set(repoInfo.id, repoInfo);
    return new GitSdkRepo(this.options, repoInfo);
  }

  async getRepo(id: string): Promise<Repo | null> {
    const repoInfo = this.repos.get(id);
    return repoInfo ? new GitSdkRepo(this.options, repoInfo) : null;
  }

  async listRepos(): Promise<RepoInfo[]> {
    return [...this.repos.values()];
  }
}

class GitSdkRepo implements Repo {
  constructor(
    private readonly adapterOptions: GitSdkOptions,
    private readonly repoInfo: RepoInfo
  ) {}

  async info(): Promise<RepoInfo> {
    return this.repoInfo;
  }

  async getRemoteUrl(options: RemoteUrlOptions): Promise<RemoteUrlResult> {
    const repoPath = `${this.repoInfo.owner}/${this.repoInfo.name}.git`;
    const url = `${this.adapterOptions.publicUrl}/${repoPath}`;
    const access = options.access ?? "write";
    const credentials = this.adapterOptions.authTokenSecret
      ? {
          username: options.actorId,
          password: mintAccessToken({
            secret: this.adapterOptions.authTokenSecret,
            actorId: options.actorId,
            repoId: this.repoInfo.id,
            access,
            ttlSeconds: options.ttlSeconds ?? 3600,
          }),
        }
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
      send: async (): Promise<CreateCommitResult> => {
        const worktree = await mkdtemp(join(tmpdir(), "redc-gitty-commit-"));
        try {
          const remote = await this.getRemoteUrl({ actorId: "sdk" });
          const branchRef = normalizeRef(options.branch);
          const branchShort = toBranchShortName(branchRef);

          await runCommand("git", ["init"], { cwd: worktree });
          await runCommand("git", ["config", "user.name", options.author.name], { cwd: worktree });
          await runCommand("git", ["config", "user.email", options.author.email], { cwd: worktree });
          await runCommand("git", ["remote", "add", "origin", remote.pushUrl], { cwd: worktree });
          try {
            await runCommand("git", ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: worktree });
          } catch {}

          const current = await this.resolveRef(branchRef);
          const base = current ?? (options.parentSha
            ? { name: branchRef, sha: options.parentSha }
            : await this.resolveRef(`refs/heads/${this.repoInfo.defaultBranch}`));

          if (base) {
            await runCommand("git", ["checkout", "-B", branchShort, base.sha], { cwd: worktree });
          } else {
            await runCommand("git", ["checkout", "--orphan", branchShort], { cwd: worktree });
          }

          for (const mutation of mutations) {
            const targetPath = join(worktree, mutation.path);
            if (mutation.op === "put") {
              await mkdir(dirname(targetPath), { recursive: true });
              await Bun.write(targetPath, mutation.content ?? "");
              continue;
            }
            await rm(targetPath, { force: true, recursive: true });
          }

          await runCommand("git", ["add", "-A"], { cwd: worktree });
          await runCommand("git", ["commit", "-m", options.message], {
            cwd: worktree,
            env: {
              GIT_AUTHOR_NAME: options.author.name,
              GIT_AUTHOR_EMAIL: options.author.email,
              GIT_COMMITTER_NAME: options.author.name,
              GIT_COMMITTER_EMAIL: options.author.email,
            },
          });

          const sha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktree })).stdout;
          await runCommand("git", ["push", "origin", `HEAD:${branchRef}`], { cwd: worktree });
          return {
            commitSha: sha,
            branch: branchRef,
          };
        } finally {
          await rm(worktree, { recursive: true, force: true });
        }
      },
    };
  }

  async getCommitDiff(range: CommitDiffRange): Promise<CommitDiffResult> {
    const base = await this.resolveRef(range.baseRef);
    const head = await this.resolveRef(range.headRef);
    if (!base || !head) {
      throw new Error(
        `cannot diff unresolved refs: base=${normalizeRef(range.baseRef)} head=${normalizeRef(range.headRef)}`
      );
    }

    const output = await this.runGit(["diff", "--name-status", `${base.sha}...${head.sha}`]);

    const files = output
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseNameStatusLine)
      .filter((file): file is CommitDiffFile => file !== null)
      .filter((file) => !range.pathPrefix || file.path.startsWith(range.pathPrefix));

    return {
      baseRef: base.name,
      headRef: head.name,
      files,
    };
  }

  async listRefs(): Promise<RefInfo[]> {
    const output = await this.runGit(["for-each-ref", "--format=%(refname)\t%(objectname)", "refs"]);
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name = "", sha = ""] = line.split("\t");
        return { name, sha };
      });
  }

  async resolveRef(name: string): Promise<RefInfo | null> {
    const fullName = normalizeRef(name);
    try {
      const sha = await this.runGit(["rev-parse", `${fullName}^{commit}`]);
      return { name: fullName, sha };
    } catch {
      return null;
    }
  }

  async createBranch(name: string, fromSha: string): Promise<RefInfo> {
    const ref = normalizeRef(name);
    await this.runGit(["update-ref", ref, fromSha]);
    return { name: ref, sha: fromSha };
  }

  async updateBranch(name: string, toSha: string, expectedOldSha?: string): Promise<RefInfo> {
    const ref = normalizeRef(name);
    const args = ["update-ref", ref, toSha];
    if (expectedOldSha) args.push(expectedOldSha);
    await this.runGit(args);
    return { name: ref, sha: toSha };
  }

  async listFiles(ref = `refs/heads/${this.repoInfo.defaultBranch}`): Promise<ListFilesResult> {
    try {
      const output = await this.runGit(["ls-tree", "-r", "--name-only", normalizeRef(ref)]);
      return { paths: output ? output.split(/\r?\n/).filter(Boolean) : [] };
    } catch {
      return { paths: [] };
    }
  }

  private async runGit(args: string[]) {
    const remote = await this.getRemoteUrl({ actorId: "sdk", access: "read" });
    const worktree = await mkdtemp(join(tmpdir(), "redc-gitty-read-"));
    try {
      await runCommand("git", ["init"], { cwd: worktree });
      await runCommand("git", ["remote", "add", "origin", remote.fetchUrl], { cwd: worktree });
      await runCommand("git", ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: worktree });

      const rewrittenArgs = args.map((arg) => {
        if (!arg.startsWith("refs/heads/")) return arg;
        return arg.replace(/^refs\/heads\//, "refs/remotes/origin/");
      });

      const result = await runCommand("git", [...rewrittenArgs], { cwd: worktree });
      return result.stdout;
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  }
}

function buildRepoInfo(options: CreateRepoOptions, defaultOwner: string): RepoInfo {
  const owner = options.owner ?? defaultOwner;
  return {
    id: `${owner}/${options.name}`,
    owner,
    name: options.name,
    defaultBranch: options.defaultBranch ?? "main",
    visibility: options.visibility ?? "private",
    ephemeral: options.ephemeral ?? false,
    baseRepo: options.baseRepo,
  };
}

function normalizeRef(name: string) {
  return name.startsWith("refs/") ? name : `refs/heads/${name}`;
}

function addBasicAuth(url: string, username: string, password: string) {
  const target = new URL(url);
  target.username = username;
  target.password = password;
  return target.toString();
}

function mintAccessToken(options: {
  secret: string;
  actorId: string;
  repoId: string;
  access: "read" | "write";
  ttlSeconds: number;
}) {
  const payload = {
    v: 1,
    sub: options.actorId,
    repoId: options.repoId,
    access: options.access,
    exp: Math.floor(Date.now() / 1000) + options.ttlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", options.secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function parseNameStatusLine(line: string): CommitDiffFile | null {
  const [status = "", ...rest] = line.split("\t");
  if (rest.length === 0) return null;

  if (status.startsWith("R")) {
    const renamedPath = rest.at(-1);
    return renamedPath ? { path: renamedPath, status: "renamed" } : null;
  }

  const path = rest[0];
  if (!path) return null;
  if (status === "A") return { path, status: "added" };
  if (status === "D") return { path, status: "deleted" };
  return { path, status: "modified" };
}

function toBranchShortName(ref: string) {
  return ref.replace(/^refs\/heads\//, "");
}
