import { cp, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentProvider, ProviderRunCallbacks } from "../pkg/daemons/src/providers/types";
import type { BlobStore } from "./blob-store";
import type { SandboxRepo, WritableSandboxRepo } from "./repo";
import { isRemoteBureauAgentProvider } from "./remote-provider";
import {
  persistChildBureauSession,
  persistRootBureauSession,
  resumeBureauAgent,
  runBureauAgent,
} from "./runtime";
import type { BureauAgentContext, BureauAgentDefinition, BureauAgentInstance } from "./sdk";
import type { BureauStoredSession } from "./session-store";
import { createBureauSessionId } from "./session-store";
import { remoteContainer, type RemoteContainerOptions } from "./sandbox-remote";
import { commitWorkspace, initEmptyWorkspace, seedWorkspace } from "./workspace-persistence";

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
};

export type PreparedBureauClone = {
  repoId: string;
  ref: string;
  dest: string;
  root: string;
  cwd: string;
};

export type BureauSandboxSession = {
  name: string;
  root: string;
  exposedRoot: string | null;
  clone(options: BureauSandboxCloneOptions): Promise<PreparedBureauClone>;
  cleanup(): Promise<void>;
};

export type BureauSandboxPrepareOptions = {
  sourceRoot: string;
  cwd?: string;
  preserve: boolean;
};

export type BureauSandboxProvider = {
  name: string;
  create(options: { preserve: boolean }): Promise<BureauSandboxSession>;
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

async function copyDirectoryContents(sourceRoot: string, destinationRoot: string): Promise<void> {
  const entries = await readdir(sourceRoot);
  for (const entry of entries) {
    await cp(join(sourceRoot, entry), join(destinationRoot, entry), {
      recursive: true,
      filter: shouldCopyPath,
    });
  }
}

export const justBashSandboxProvider: BureauSandboxProvider = {
  name: "just-bash",
  async create(options) {
    const sandboxRoot = await mkdtemp(join(tmpdir(), "bureau-"));
    return {
      name: "just-bash",
      root: sandboxRoot,
      exposedRoot: sandboxRoot,
      async clone(cloneOptions) {
        const destinationRoot = join(sandboxRoot, cloneOptions.dest);
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
        return {
          repoId: cloneOptions.repo.id,
          ref: cloneOptions.ref,
          dest: cloneOptions.dest,
          root: destinationRoot,
          cwd: relativeCwd && !isAbsolute(relativeCwd)
            ? join(destinationRoot, relativeCwd)
            : destinationRoot,
        };
      },
      async cleanup() {
        if (options.preserve) return;
        await rm(sandboxRoot, { recursive: true, force: true });
      },
    };
  },
  async prepare(options) {
    const session = await this.create({ preserve: options.preserve });
    const sourceRoot = resolve(options.sourceRoot);
    const destinationRoot = join(session.root, "workspace");
    await mkdir(destinationRoot, { recursive: true });
    await copyDirectoryContents(sourceRoot, destinationRoot);
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
  remoteContainer(options?: RemoteContainerOptions): BureauSandboxProvider {
    return remoteContainer(options);
  },
};

export type BureauSandboxContextBase = Omit<
  BureauAgentContext<unknown>,
  "sessionId" | "input" | "cwd" | "root"
>;

export type BureauSandboxRunOptions<Input> = {
  definition: BureauAgentDefinition<Input>;
  input: Input;
  args: unknown;
  maxTurns: number;
  mode?: string | null;
  sourceSha?: string | null;
  providerCallbacks?: ProviderRunCallbacks;
};

export type BureauSandboxRunWithAgentOptions<Input> = {
  agent: BureauAgentInstance<Input>;
  userInput?: string | null;
  maxTurns: number;
  mode?: string | null;
  sourceSha?: string | null;
  providerCallbacks?: ProviderRunCallbacks;
};

export type BureauSandboxRunOutcome<Input> = Awaited<
  ReturnType<typeof runBureauAgent<Input>>
>;

export type BureauSandboxResumeOptions<Input> = BureauSandboxRunOptions<Input> & {
  parentSession: BureauStoredSession;
};

export type BureauSandboxResumeWithAgentOptions<Input> = BureauSandboxRunWithAgentOptions<Input> & {
  parentSession: BureauStoredSession;
};

export type CloseResult = {
  workspaceRef?: string;
};

export type BureauSandbox = {
  readonly workspaceDir: string;
  run<Input>(
    options: BureauSandboxRunOptions<Input> | BureauSandboxRunWithAgentOptions<Input>,
  ): Promise<BureauSandboxRunOutcome<Input>>;
  resume<Input>(
    options: BureauSandboxResumeOptions<Input> | BureauSandboxResumeWithAgentOptions<Input>,
  ): Promise<BureauSandboxRunOutcome<Input>>;
  close(): Promise<CloseResult>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type CreateSandboxOptions = {
  provider: BureauSandboxProvider;
  agentProvider: AgentProvider;
  contextBase: BureauSandboxContextBase;
  maxWallclockMs: number;
  blobStore?: BlobStore;
  /**
   * When set, the workspace persists across Sandboxes via this repo.
   * `sessionId` becomes required so the scratch ref name is deterministic.
   * `resumeFrom` (a workspaceRef returned by a prior `close()`) seeds the
   * workspace from that ref instead of starting empty.
   */
  workspaceRepo?: WritableSandboxRepo;
  sessionId?: string;
  resumeFrom?: string;
};

export async function createSandbox(options: CreateSandboxOptions): Promise<BureauSandbox> {
  const prepared = !options.workspaceRepo && options.contextBase
    ? await options.provider.prepare({
      sourceRoot: options.contextBase.sourceRoot,
      cwd: options.contextBase.cwd,
      preserve: false,
    })
    : null;
  const session = prepared ? null : await options.provider.create({ preserve: false });
  const workspaceDir = prepared?.root ?? session!.root;

  if (options.workspaceRepo) {
    if (!options.sessionId && !options.resumeFrom) {
      throw new Error("createSandbox: workspaceRepo requires sessionId or resumeFrom");
    }
    if (options.resumeFrom) {
      await seedWorkspace({
        workspaceDir,
        repo: options.workspaceRepo,
        ref: options.resumeFrom,
      });
    } else {
      await initEmptyWorkspace({ workspaceDir });
    }
  }

  let closed = false;
  const close = async (): Promise<CloseResult> => {
    if (closed) return {};
    closed = true;
    let workspaceRef: string | undefined;
    if (options.workspaceRepo && options.sessionId) {
      workspaceRef = await commitWorkspace({
        workspaceDir,
        repo: options.workspaceRepo,
        ref: workspaceRefFor(options.sessionId),
        message: `bureau session ${options.sessionId}`,
      });
    }
    await (prepared?.cleanup ?? session!.cleanup)();
    return workspaceRef !== undefined ? { workspaceRef } : {};
  };
  const dispose = async (): Promise<void> => {
    await close();
  };

  return {
    workspaceDir,
    async run<Input>(
      runOptions: BureauSandboxRunOptions<Input> | BureauSandboxRunWithAgentOptions<Input>,
    ): Promise<BureauSandboxRunOutcome<Input>> {
      const normalized = normalizeRunOptions(runOptions);
      if (normalized.agent && isRemoteBureauAgentProvider(options.agentProvider)) {
        const sessionId = createBureauSessionId();
        const result = await options.agentProvider.runBureauAgent({
          root: workspaceDir,
          agentName: normalized.agent.name,
          args: normalized.agent.args,
          userInput: normalized.userInput ?? null,
          maxTurns: normalized.maxTurns,
          maxWallclockMs: options.maxWallclockMs,
          ...normalized.providerCallbacks,
        });
        const context = {
          ...(normalized.contextBase ?? (options.contextBase as BureauSandboxContextBase)),
          cwd: workspaceDir,
          root: workspaceDir,
        } as Omit<BureauAgentContext<Input>, "sessionId" | "input">;
        const session = await persistRootBureauSession({
          context,
          sessionId,
          args: normalized.agent.args,
          result,
          mode: normalized.mode,
          sourceSha: normalized.sourceSha,
          blobStore: options.blobStore,
          workspaceDir,
        });
        return { context: { ...context, sessionId, input: normalized.input }, plan: null as never, result, session };
      }
      return runBureauAgent({
        definition: normalized.definition,
        context: {
          ...(normalized.contextBase ?? (options.contextBase as BureauSandboxContextBase)),
          cwd: workspaceDir,
          root: workspaceDir,
        } as Omit<BureauAgentContext<Input>, "sessionId" | "input">,
        input: normalized.input,
        args: normalized.args,
        provider: options.agentProvider,
        maxTurns: normalized.maxTurns,
        maxWallclockMs: options.maxWallclockMs,
        mode: normalized.mode,
        sourceSha: normalized.sourceSha,
        providerCallbacks: normalized.providerCallbacks,
        blobStore: options.blobStore,
      });
    },
    async resume<Input>(
      runOptions: BureauSandboxResumeOptions<Input> | BureauSandboxResumeWithAgentOptions<Input>,
    ): Promise<BureauSandboxRunOutcome<Input>> {
      const normalized = normalizeRunOptions(runOptions);
      if (normalized.agent && isRemoteBureauAgentProvider(options.agentProvider)) {
        const sessionId = createBureauSessionId();
        const result = await options.agentProvider.resumeBureauAgent({
          root: workspaceDir,
          agentName: normalized.agent.name,
          args: normalized.agent.args,
          userInput: normalized.userInput ?? null,
          parentSession: runOptions.parentSession,
          maxTurns: normalized.maxTurns,
          maxWallclockMs: options.maxWallclockMs,
          ...normalized.providerCallbacks,
        });
        const context = {
          ...(normalized.contextBase ?? (options.contextBase as BureauSandboxContextBase)),
          cwd: workspaceDir,
          root: workspaceDir,
        } as Omit<BureauAgentContext<Input>, "sessionId" | "input">;
        const session = await persistChildBureauSession({
          context,
          sessionId,
          parentSession: runOptions.parentSession,
          result,
          mode: normalized.mode,
          sourceSha: normalized.sourceSha,
          blobStore: options.blobStore,
          workspaceDir,
        });
        return { context: { ...context, sessionId, input: normalized.input }, plan: null as never, result, session };
      }
      return resumeBureauAgent({
        definition: normalized.definition,
        context: {
          ...(normalized.contextBase ?? (options.contextBase as BureauSandboxContextBase)),
          cwd: workspaceDir,
          root: workspaceDir,
        } as Omit<BureauAgentContext<Input>, "sessionId" | "input">,
        input: normalized.input,
        parentSession: runOptions.parentSession,
        provider: options.agentProvider,
        maxTurns: normalized.maxTurns,
        maxWallclockMs: options.maxWallclockMs,
        mode: normalized.mode,
        sourceSha: normalized.sourceSha,
        providerCallbacks: normalized.providerCallbacks,
        blobStore: options.blobStore,
      });
    },
    close,
    [Symbol.asyncDispose]: dispose,
  };
}

export type BureauStoredSessionResult = BureauStoredSession;

function workspaceRefFor(sessionId: string): string {
  return `bureau/sessions/${sessionId}`;
}

export const bureau = {
  createSandbox,
  async run<Input>(
    options:
      | (CreateSandboxOptions & BureauSandboxRunOptions<Input>)
      | (Omit<CreateSandboxOptions, "contextBase"> & BureauSandboxRunWithAgentOptions<Input>),
  ): Promise<BureauSandboxRunOutcome<Input>> {
    const normalized = normalizeRunOptions(options);
    await using sb = await createSandbox({
      provider: options.provider,
      agentProvider: options.agentProvider,
      contextBase: normalized.contextBase ?? (options as CreateSandboxOptions).contextBase,
      maxWallclockMs: options.maxWallclockMs,
      blobStore: options.blobStore,
    });
    return "agent" in options
      ? sb.run({
        agent: options.agent,
        userInput: options.userInput,
        maxTurns: normalized.maxTurns,
        mode: normalized.mode,
        sourceSha: normalized.sourceSha,
        providerCallbacks: normalized.providerCallbacks,
      })
      : sb.run({
        definition: normalized.definition,
        input: normalized.input,
        args: normalized.args,
        maxTurns: normalized.maxTurns,
        mode: normalized.mode,
        sourceSha: normalized.sourceSha,
        providerCallbacks: normalized.providerCallbacks,
      });
  },
  async resume<Input>(
    options:
      | (CreateSandboxOptions & BureauSandboxResumeOptions<Input>)
      | (Omit<CreateSandboxOptions, "contextBase"> & BureauSandboxResumeWithAgentOptions<Input>),
  ): Promise<BureauSandboxRunOutcome<Input>> {
    const normalized = normalizeRunOptions(options);
    await using sb = await createSandbox({
      provider: options.provider,
      agentProvider: options.agentProvider,
      contextBase: normalized.contextBase ?? (options as CreateSandboxOptions).contextBase,
      maxWallclockMs: options.maxWallclockMs,
      blobStore: options.blobStore,
    });
    return "agent" in options
      ? sb.resume({
        agent: options.agent,
        userInput: options.userInput,
        parentSession: options.parentSession,
        maxTurns: normalized.maxTurns,
        mode: normalized.mode,
        sourceSha: normalized.sourceSha,
        providerCallbacks: normalized.providerCallbacks,
      })
      : sb.resume({
        definition: normalized.definition,
        input: normalized.input,
        parentSession: options.parentSession,
        args: normalized.args,
        maxTurns: normalized.maxTurns,
        mode: normalized.mode,
        sourceSha: normalized.sourceSha,
        providerCallbacks: normalized.providerCallbacks,
      });
  },
};

function normalizeRunOptions<Input>(
  options: BureauSandboxRunOptions<Input> | BureauSandboxRunWithAgentOptions<Input>,
): {
  agent?: BureauAgentInstance<Input>;
  userInput?: string | null;
  definition: BureauAgentDefinition<Input>;
  contextBase?: BureauSandboxContextBase;
  input: Input;
  args: unknown;
  maxTurns: number;
  mode?: string | null;
  sourceSha?: string | null;
  providerCallbacks?: ProviderRunCallbacks;
} {
  if ("agent" in options) {
    return {
      agent: options.agent,
      userInput: options.userInput ?? null,
      definition: options.agent.definition,
      contextBase: options.agent.context as BureauSandboxContextBase,
      input: options.agent.buildInput(options.userInput ?? null),
      args: options.agent.args,
      maxTurns: options.maxTurns,
      mode: options.mode,
      sourceSha: options.sourceSha,
      providerCallbacks: options.providerCallbacks,
    };
  }

  return {
    definition: options.definition,
    input: options.input,
    args: options.args,
    maxTurns: options.maxTurns,
    mode: options.mode,
    sourceSha: options.sourceSha,
    providerCallbacks: options.providerCallbacks,
  };
}
