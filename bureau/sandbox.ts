import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { WorkflowObserver } from "./observability";
import type { SandboxRepo } from "./repo";

export type PreparedBureauWorkspace = {
  root: string;
  cwd: string;
  exposedRoot: string | null;
  cleanup(): Promise<void>;
};

export type BureauSandboxCloneOptions = {
  repo: SandboxRepo;
  ref: string;
  dest: string;
  cwd?: string;
  role?: string;
};

export type PreparedBureauClone = {
  repoId: string;
  ref: string;
  dest: string;
  root: string;
  cwd: string;
};

export type BureauSandboxSession = {
  name: "just-bash";
  root: string;
  exposedRoot: string | null;
  clone(options: BureauSandboxCloneOptions): Promise<PreparedBureauClone>;
  cleanup(): Promise<void>;
};

export type BureauSandboxPrepareOptions = {
  sourceRoot: string;
  cwd?: string;
  preserve: boolean;
  observer?: WorkflowObserver;
};

export type BureauSandboxCreateOptions = {
  preserve: boolean;
  observer?: WorkflowObserver;
};

export type BureauSandboxProvider = {
  name: "just-bash";
  create(options: BureauSandboxCreateOptions): Promise<BureauSandboxSession>;
  prepare(options: BureauSandboxPrepareOptions): Promise<PreparedBureauWorkspace>;
};

function shouldCopyPath(source: string): boolean {
  const normalized = source.replaceAll("\\", "/");
  if (
    normalized.endsWith("/.git") ||
    normalized.includes("/.git/") ||
    normalized.endsWith("/node_modules") ||
    normalized.includes("/node_modules/") ||
    normalized.endsWith("/.turbo") ||
    normalized.includes("/.turbo/") ||
    normalized.endsWith("/.sst") ||
    normalized.includes("/.sst/") ||
    normalized.endsWith("/.codex-artifacts") ||
    normalized.includes("/.codex-artifacts/") ||
    normalized.endsWith("/.daemons-artifacts") ||
    normalized.includes("/.daemons-artifacts/")
  ) {
    return false;
  }
  return true;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return { ok: true, stdout };
  return { ok: false, stdout, stderr };
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new Error(`git command failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export const justBashSandboxProvider: BureauSandboxProvider = {
  name: "just-bash",
  async create(options) {
    const observer = options.observer;
    const sandboxRoot = await mkdtemp(join(tmpdir(), "bureau-"));
    observer?.event("sandbox.created", {
      provider: "just-bash",
      sandboxRoot,
      preserved: options.preserve,
    });
    return {
      name: "just-bash",
      root: sandboxRoot,
      exposedRoot: sandboxRoot,
      async clone(cloneOptions) {
        const destinationRoot = join(sandboxRoot, cloneOptions.dest);
        const startedAt = Date.now();
        observer?.event("sandbox.clone.started", {
          provider: "just-bash",
          sandboxRoot,
          repo: cloneOptions.repo.id,
          ref: cloneOptions.ref,
          dest: cloneOptions.dest,
          role: cloneOptions.role ?? null,
        });
        try {
          await mkdir(destinationRoot, { recursive: true });
          const remote = await cloneOptions.repo.getReadRemote(cloneOptions.ref);
          await gitOrThrow(destinationRoot, ["init", "-q"]);
          await gitOrThrow(destinationRoot, ["remote", "add", "origin", remote.fetchUrl]);
          await gitOrThrow(destinationRoot, [
            ...(remote.gitConfigArgs ?? []),
            "fetch",
            "--depth",
            "1",
            "origin",
            remote.ref,
          ]);
          await gitOrThrow(destinationRoot, ["checkout", "--detach", "FETCH_HEAD"]);

          const requestedCwd = resolve(destinationRoot, cloneOptions.cwd ?? ".");
          const relativeCwd = relative(destinationRoot, requestedCwd);
          const result: PreparedBureauClone = {
            repoId: cloneOptions.repo.id,
            ref: cloneOptions.ref,
            dest: cloneOptions.dest,
            root: destinationRoot,
            cwd: relativeCwd && !isAbsolute(relativeCwd)
              ? join(destinationRoot, relativeCwd)
              : destinationRoot,
          };
          observer?.event("sandbox.clone.completed", {
            provider: "just-bash",
            sandboxRoot,
            repo: cloneOptions.repo.id,
            ref: cloneOptions.ref,
            dest: cloneOptions.dest,
            root: result.root,
            role: cloneOptions.role ?? null,
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          observer?.event("sandbox.clone.failed", {
            provider: "just-bash",
            sandboxRoot,
            repo: cloneOptions.repo.id,
            ref: cloneOptions.ref,
            dest: cloneOptions.dest,
            role: cloneOptions.role ?? null,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      async cleanup() {
        if (options.preserve) {
          observer?.event("sandbox.preserved", {
            provider: "just-bash",
            sandboxRoot,
          });
          return;
        }
        await rm(sandboxRoot, { recursive: true, force: true });
        observer?.event("sandbox.cleaned_up", {
          provider: "just-bash",
          sandboxRoot,
        });
      },
    };
  },
  async prepare(options) {
    const session = await this.create({
      preserve: options.preserve,
      observer: options.observer,
    });
    const sourceRoot = resolve(options.sourceRoot);
    const destinationRoot = join(session.root, "workspace");
    await mkdir(destinationRoot, { recursive: true });
    await cp(sourceRoot, destinationRoot, {
      recursive: true,
      filter: shouldCopyPath,
    });
    const requestedCwd = resolve(options.cwd ?? sourceRoot);
    const relativeCwd = relative(sourceRoot, requestedCwd);
    return {
      root: destinationRoot,
      cwd: relativeCwd && !isAbsolute(relativeCwd) ? join(destinationRoot, relativeCwd) : destinationRoot,
      exposedRoot: session.exposedRoot,
      cleanup: session.cleanup,
    };
  },
};

export const sandbox = {
  justBash(): BureauSandboxProvider {
    return justBashSandboxProvider;
  },
};
