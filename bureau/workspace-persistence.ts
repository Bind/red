import type { WritableSandboxRepo } from "./repo";

/**
 * Seed an empty workspace directory by fetching `ref` from `repo` and
 * checking it out. Used by createSandbox when `resumeFrom` is set.
 */
export async function seedWorkspace(input: {
  workspaceDir: string;
  repo: WritableSandboxRepo;
  ref: string;
}): Promise<void> {
  const remote = await input.repo.getReadRemote(input.ref);
  await gitOrThrow(input.workspaceDir, ["init", "-q"]);
  await gitOrThrow(input.workspaceDir, ["remote", "add", "origin", remote.fetchUrl]);
  await gitOrThrow(input.workspaceDir, [
    ...(remote.gitConfigArgs ?? []),
    "fetch",
    "origin",
    remote.ref,
  ]);
  await gitOrThrow(input.workspaceDir, ["checkout", "--detach", "FETCH_HEAD"]);
}

/**
 * Initialize a workspace directory as a git repo so it can later be
 * committed and pushed. Used by createSandbox when a workspaceRepo is set
 * but no resumeFrom is provided.
 */
export async function initEmptyWorkspace(input: { workspaceDir: string }): Promise<void> {
  await gitOrThrow(input.workspaceDir, ["init", "-q"]);
}

/**
 * Commit any workspace edits and push to `ref` on `repo`. Returns the ref
 * if anything was committed, or undefined if the workspace was clean.
 *
 * Force-push is safe here because the scratch ref is owned by the session.
 */
export async function commitWorkspace(input: {
  workspaceDir: string;
  repo: WritableSandboxRepo;
  ref: string;
  message: string;
}): Promise<string | undefined> {
  const dirty = await runGit(input.workspaceDir, ["status", "--porcelain"]);
  if (!dirty.ok) {
    throw new Error(`workspace is not a git repo: ${dirty.stderr}`);
  }
  const hasUncommitted = dirty.stdout.trim().length > 0;
  const hasAnyCommit = (await runGit(input.workspaceDir, ["rev-parse", "HEAD"])).ok;

  if (!hasUncommitted && !hasAnyCommit) {
    return undefined;
  }

  if (hasUncommitted) {
    await gitOrThrow(input.workspaceDir, ["add", "-A"]);
    // Bureau scratch commits are internal session state, not human authorship,
    // so we deliberately do not sign them.
    await gitOrThrow(input.workspaceDir, [
      "-c",
      "user.name=bureau",
      "-c",
      "user.email=bureau@local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--no-gpg-sign",
      "-m",
      input.message,
    ]);
  }

  const remote = await input.repo.getWriteRemote(input.ref);
  // Replace any existing 'origin' so we don't conflict with seedWorkspace.
  await runGit(input.workspaceDir, ["remote", "remove", "origin"]);
  await gitOrThrow(input.workspaceDir, ["remote", "add", "origin", remote.fetchUrl]);
  await gitOrThrow(input.workspaceDir, [
    ...(remote.gitConfigArgs ?? []),
    "push",
    "--force",
    "origin",
    `HEAD:${remote.ref}`,
  ]);

  return input.ref;
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
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
