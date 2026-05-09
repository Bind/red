import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { copyDirectoryContents, resolveSandboxCwd } from "./sandbox-fs";
import type {
  BureauSandboxPrepareOptions,
  BureauSandboxProvider,
  BureauSandboxSession,
  PreparedBureauWorkspace,
  PreparedBureauClone,
  BureauSandboxCloneOptions,
} from "./sandbox";

export type RemoteContainerOptions = {
  runtime?: "docker" | "podman";
  image?: string;
  minDiskFreeKb?: number;
};

type RuntimeName = NonNullable<RemoteContainerOptions["runtime"]>;

type MaterializedRemote = {
  fetchUrl: string;
  mounts: MountSpec[];
  gitConfigArgs?: string[];
};

type MountSpec = {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
};

const DEFAULT_RUNTIME: RuntimeName = "docker";
const DEFAULT_IMAGE = "alpine/git:2.49.1";
const DEFAULT_MIN_DISK_FREE_KB = 1_048_576;

export function remoteContainer(options: RemoteContainerOptions = {}): BureauSandboxProvider {
  const runtime = options.runtime ?? DEFAULT_RUNTIME;
  const image = options.image ?? DEFAULT_IMAGE;
  const minDiskFreeKb = options.minDiskFreeKb ?? DEFAULT_MIN_DISK_FREE_KB;

  return {
    kind: "remote",
    name: "remote-container",
    async create(createOptions): Promise<BureauSandboxSession> {
      const sandboxRoot = await mkdtemp(join(tmpdir(), "bureau-remote-"));
      await ensureRuntimeHealthy({ runtime, image, diskCheckPath: sandboxRoot, minDiskFreeKb });

      return {
        name: "remote-container",
        root: sandboxRoot,
        exposedRoot: sandboxRoot,
        async clone(cloneOptions) {
          return cloneWithRuntime({
            runtime,
            image,
            sandboxRoot,
            cloneOptions,
          });
        },
        async cleanup() {
          if (createOptions.preserve) return;
          await rm(sandboxRoot, { recursive: true, force: true });
        },
      };
    },
    async prepare(prepareOptions): Promise<PreparedBureauWorkspace> {
      const session = await this.create({ preserve: prepareOptions.preserve });
      const sourceRoot = resolve(prepareOptions.sourceRoot);
      const destinationRoot = join(session.root, "workspace");
      await mkdir(destinationRoot, { recursive: true });
      await copyDirectoryContents(sourceRoot, destinationRoot);
      return {
        root: destinationRoot,
        cwd: resolveSandboxCwd(sourceRoot, destinationRoot, prepareOptions.cwd),
        exposedRoot: session.exposedRoot,
        cleanup: session.cleanup,
      };
    },
  };
}

async function cloneWithRuntime(input: {
  runtime: RuntimeName;
  image: string;
  sandboxRoot: string;
  cloneOptions: BureauSandboxCloneOptions;
}): Promise<PreparedBureauClone> {
  const destinationRoot = join(input.sandboxRoot, input.cloneOptions.dest);
  await mkdir(destinationRoot, { recursive: true });

  const remote = await input.cloneOptions.repo.getReadRemote(input.cloneOptions.ref);
  const materialized = materializeRemote(remote.fetchUrl, remote.gitConfigArgs);
  await runContainerCommand({
    runtime: input.runtime,
    image: input.image,
    workdir: "/workspace",
    mounts: [
      { hostPath: destinationRoot, containerPath: "/workspace" },
      ...materialized.mounts,
    ],
    script: [
      "git init -q .",
      `git remote add origin ${shellQuote(materialized.fetchUrl)}`,
      [
        "git",
        ...(materialized.gitConfigArgs ?? []),
        "fetch",
        "--depth",
        "1",
        "origin",
        remote.ref,
      ].map(shellQuote).join(" "),
      "git checkout --detach FETCH_HEAD",
    ].join(" && "),
  });

  return {
    repoId: input.cloneOptions.repo.id,
    ref: input.cloneOptions.ref,
    dest: input.cloneOptions.dest,
    root: destinationRoot,
    cwd: resolveSandboxCwd(destinationRoot, destinationRoot, resolve(destinationRoot, input.cloneOptions.cwd ?? ".")),
  };
}

function materializeRemote(fetchUrl: string, gitConfigArgs?: string[]): MaterializedRemote {
  if (isAbsolute(fetchUrl)) {
    return {
      fetchUrl: "/remote-source",
      mounts: [{ hostPath: fetchUrl, containerPath: "/remote-source", readOnly: true }],
      gitConfigArgs,
    };
  }

  return {
    fetchUrl: rewriteLocalhost(fetchUrl),
    mounts: [],
    gitConfigArgs,
  };
}

function rewriteLocalhost(fetchUrl: string): string {
  return fetchUrl.replace(/:\/\/(?:localhost|127\.0\.0\.1)(?=[:/]|$)/, "://host.docker.internal");
}

async function ensureRuntimeHealthy(input: {
  runtime: RuntimeName;
  image: string;
  diskCheckPath: string;
  minDiskFreeKb: number;
}): Promise<void> {
  await assertDiskSpace(input.diskCheckPath, input.minDiskFreeKb);
  await runHostCommand([input.runtime, "info"]);
  await runHostCommand([input.runtime, "image", "inspect", input.image]);
  await runContainerCommand({
    runtime: input.runtime,
    image: input.image,
    script: "true",
  });
}

async function assertDiskSpace(path: string, minDiskFreeKb: number): Promise<void> {
  const result = await runHostCommand(["df", "-Pk", path]);
  const lines = result.stdout.trim().split("\n");
  const row = lines.at(-1);
  if (!row) {
    throw new Error(`remote-container preflight failed: unable to read disk space for ${path}`);
  }
  const columns = row.trim().split(/\s+/);
  const availableKb = Number.parseInt(columns[3] ?? "", 10);
  if (!Number.isFinite(availableKb)) {
    throw new Error(`remote-container preflight failed: unable to parse disk space for ${path}`);
  }
  if (availableKb < minDiskFreeKb) {
    throw new Error(
      `remote-container preflight failed: only ${availableKb}KB free at ${path}; requires at least ${minDiskFreeKb}KB`,
    );
  }
}

async function runContainerCommand(input: {
  runtime: RuntimeName;
  image: string;
  script: string;
  mounts?: MountSpec[];
  workdir?: string;
}): Promise<void> {
  const args = [input.runtime, "run", "--rm"];
  if (input.runtime === "docker") {
    args.push("--add-host", "host.docker.internal:host-gateway");
  }
  args.push("--entrypoint", "sh");
  for (const mount of input.mounts ?? []) {
    args.push(
      "-v",
      `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`,
    );
  }
  if (input.workdir) {
    args.push("-w", input.workdir);
  }
  args.push(input.image, "-lc", input.script);
  await runHostCommand(args);
}

async function runHostCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: args,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `remote-container command failed (${args.join(" ")}): ${(stderr || stdout).trim()}`,
    );
  }
  return { stdout, stderr };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
