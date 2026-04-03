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

  async getRepoByName(owner: string, name: string): Promise<Repo | null> {
    return this.getRepo(`${owner}/${name}`);
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

    return this.withFetchedRemote(async (worktree) => {
      const diffArgs = ["diff", `${base.sha}...${head.sha}`];
      if (range.pathPrefix) diffArgs.push("--", range.pathPrefix);

      const [nameStatusOutput, numstatOutput, patchOutput] = await Promise.all([
        runCommand("git", ["-C", worktree, ...diffArgs.slice(0, 2), "--name-status", ...diffArgs.slice(2)]),
        runCommand("git", ["-C", worktree, ...diffArgs.slice(0, 2), "--numstat", ...diffArgs.slice(2)]),
        range.includePatch
          ? runCommand("git", ["-C", worktree, ...diffArgs, "--patch", "--find-renames"])
          : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      ]);

      const statsByPath = parseNumstat(numstatOutput.stdout);
      const patchByPath = range.includePatch ? parsePerFilePatch(patchOutput.stdout) : new Map<string, string>();
      const files = nameStatusOutput.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map(parseNameStatusLine)
        .filter((file): file is Omit<CommitDiffFile, "additions" | "deletions" | "patch"> => file !== null)
        .map((file) => ({
          ...file,
          additions: statsByPath.get(file.path)?.additions ?? 0,
          deletions: statsByPath.get(file.path)?.deletions ?? 0,
          patch: range.includePatch ? patchByPath.get(file.path) : undefined,
        }))
        .filter((file) => !range.pathPrefix || file.path.startsWith(range.pathPrefix));

      return {
        baseRef: base.name,
        headRef: head.name,
        files,
        totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
        patch: range.includePatch ? patchOutput.stdout : undefined,
      };
    });
  }

  async readTextFile(options: { ref: string; path: string }): Promise<string | null> {
    const ref = await this.resolveRef(options.ref);
    if (!ref) {
      throw new Error(`cannot read file from unresolved ref: ${normalizeRef(options.ref)}`);
    }

    try {
      return await this.withFetchedRemote(async (worktree) => {
        const targetRef = rewriteRemoteRef(ref.name);
        const result = await runCommand("git", ["-C", worktree, "show", `${targetRef}:${options.path}`]);
        return result.stdout;
      });
    } catch (error) {
      if (isMissingPathError(error, options.path)) {
        return null;
      }
      throw error;
    }
  }

  async listRefs(): Promise<RefInfo[]> {
    return this.withFetchedRemote(async (worktree) => {
      const output = await runCommand("git", [
        "-C",
        worktree,
        "for-each-ref",
        "--format=%(refname)\t%(objectname)\t%(subject)\t%(committerdate:iso-strict)",
        "refs/remotes/origin",
      ]);
      return output.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => parseRefLine(line))
        .filter((ref): ref is RefInfo => ref !== null);
    });
  }

  async listBranches(): Promise<Array<RefInfo & { protected?: boolean }>> {
    const refs = await this.listRefs();
    return refs
      .filter((ref) => ref.name.startsWith("refs/heads/"))
      .map((ref) => ({
        ...ref,
        name: toBranchShortName(ref.name),
        protected: false,
      }));
  }

  async resolveRef(name: string): Promise<RefInfo | null> {
    const fullName = normalizeRef(name);
    try {
      return await this.withFetchedRemote(async (worktree) => {
        const rewrittenRef = rewriteRemoteRef(fullName);
        const output = await runCommand("git", [
          "-C",
          worktree,
          "log",
          "-1",
          "--format=%H\t%s\t%cI",
          rewrittenRef,
        ]);
        const [sha = "", message = "", timestamp = ""] = output.stdout.split("\t");
        if (!sha) return null;
        return {
          name: fullName,
          sha,
          message: message || undefined,
          timestamp: timestamp || undefined,
        };
      });
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
    return this.withFetchedRemote(async (worktree) => {
      const rewrittenArgs = args.map((arg) => {
        if (!arg.startsWith("refs/heads/")) return arg;
        return rewriteRemoteRef(arg);
      });

      const result = await runCommand("git", ["-C", worktree, ...rewrittenArgs]);
      return result.stdout;
    });
  }

  private async withFetchedRemote<T>(fn: (worktree: string) => Promise<T>) {
    const remote = await this.getRemoteUrl({ actorId: "sdk", access: "read" });
    const worktree = await mkdtemp(join(tmpdir(), "redc-gitty-read-"));
    try {
      await runCommand("git", ["init"], { cwd: worktree });
      await runCommand("git", ["remote", "add", "origin", remote.fetchUrl], { cwd: worktree });
      await runCommand("git", ["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"], { cwd: worktree });
      return await fn(worktree);
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

function rewriteRemoteRef(name: string) {
  return name.replace(/^refs\/heads\//, "refs/remotes/origin/");
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
    return renamedPath ? { path: renamedPath, status: "renamed", additions: 0, deletions: 0 } : null;
  }

  const path = rest[0];
  if (!path) return null;
  if (status === "A") return { path, status: "added", additions: 0, deletions: 0 };
  if (status === "D") return { path, status: "deleted", additions: 0, deletions: 0 };
  return { path, status: "modified", additions: 0, deletions: 0 };
}

function toBranchShortName(ref: string) {
  return ref.replace(/^refs\/heads\//, "");
}

function parseNumstat(output: string) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [additionsText = "0", deletionsText = "0", ...paths] = line.split("\t");
    const resolvedPath = paths.length > 1 ? paths.at(-1) : paths[0];
    if (!resolvedPath) continue;
    stats.set(resolvedPath, {
      additions: parseNumstatValue(additionsText),
      deletions: parseNumstatValue(deletionsText),
    });
  }
  return stats;
}

function parseNumstatValue(value: string) {
  return value === "-" ? 0 : Number.parseInt(value, 10) || 0;
}

function parsePerFilePatch(patch: string) {
  const patches = new Map<string, string>();
  const sections = patch.split(/^diff --git /m).filter(Boolean);
  for (const section of sections) {
    const normalizedSection = `diff --git ${section}`;
    const firstLine = normalizedSection.split(/\r?\n/, 1)[0] ?? "";
    const match = firstLine.match(/^diff --git a\/.+ b\/(.+)$/);
    if (!match) continue;
    patches.set(match[1], normalizedSection.trim());
  }
  return patches;
}

function parseRefLine(line: string): RefInfo | null {
  const [rawName = "", sha = "", message = "", timestamp = ""] = line.split("\t");
  if (!rawName || !sha) return null;
  return {
    name: rawName.replace(/^refs\/remotes\/origin\//, "refs/heads/"),
    sha,
    message: message || undefined,
    timestamp: timestamp || undefined,
  };
}

function isMissingPathError(error: unknown, path: string) {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes(`path '${path}' does not exist`) ||
    error.message.includes(`path '${path}' exists on disk, but not in`) ||
    error.message.includes(`fatal: invalid object name`)
  );
}
