import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MirrorGitClient, MirrorRepoConfig } from "../util/types";

interface CommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

async function runCommand(command: string, args: string[], options: CommandOptions = {}) {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
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
      `${command} ${args.join(" ")} failed with exit code ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

function repoCachePath(cacheDir: string, repoId: string) {
  const digest = createHash("sha256").update(repoId).digest("hex").slice(0, 12);
  const safeId = repoId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return join(cacheDir, `${safeId}-${digest}.git`);
}

export class ShellMirrorGitClient implements MirrorGitClient {
  async ensureLocalMirror(repo: MirrorRepoConfig, cacheDir: string): Promise<string> {
    mkdirSync(cacheDir, { recursive: true });
    const cachePath = repoCachePath(cacheDir, repo.id);

    if (!existsSync(cachePath)) {
      await runCommand("git", ["clone", "--mirror", repo.sourceUrl, cachePath]);
    }

    await runCommand("git", ["-C", cachePath, "remote", "set-url", "origin", repo.sourceUrl]);

    try {
      await runCommand("git", ["-C", cachePath, "remote", "set-url", "target", repo.targetUrl]);
    } catch {
      await runCommand("git", ["-C", cachePath, "remote", "remove", "target"]).catch(
        () => undefined,
      );
      await runCommand("git", ["-C", cachePath, "remote", "add", "target", repo.targetUrl]);
    }

    await runCommand("git", [
      "-C",
      cachePath,
      "fetch",
      "--prune",
      "--prune-tags",
      "origin",
      "+refs/*:refs/*",
    ]);

    return cachePath;
  }

  async resolveLocalRef(cachePath: string, ref: string): Promise<string> {
    const result = await runCommand("git", ["-C", cachePath, "rev-parse", ref]);
    return result.stdout.trim();
  }

  async pushMirror(cachePath: string, repo: MirrorRepoConfig): Promise<void> {
    await runCommand("git", ["-C", cachePath, "remote", "set-url", "target", repo.targetUrl]);
    await runCommand("git", ["-C", cachePath, "push", "--mirror", "target"]);
  }

  async resolveRemoteRef(repo: MirrorRepoConfig): Promise<string> {
    const result = await runCommand("git", ["ls-remote", repo.targetUrl, repo.trackedRef]);
    const [sha = ""] = result.stdout.split(/\s+/);
    if (!sha) {
      throw new Error(`target ref ${repo.trackedRef} is missing on ${repo.targetUrl}`);
    }
    return sha;
  }
}
