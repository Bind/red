import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { SandboxRepoRemote, WritableSandboxRepo } from "./repo";

/**
 * A bare git repo on the local filesystem used as a scratch backing store
 * for bureau Workspaces. Tests and the in-process sandbox use this; the
 * remote-container sandbox will use GrsRepo (also Writable) instead.
 *
 * Refs are addressed by string (e.g. `bureau/<sessionId>`); the caller
 * decides the naming scheme.
 */
export class LocalScratchRepo implements WritableSandboxRepo {
  readonly id: string;
  private readonly rootDir: string;
  private initialized: Promise<void> | null = null;

  constructor(options: { rootDir: string; id?: string }) {
    this.rootDir = resolve(options.rootDir);
    this.id = options.id ?? `scratch:${this.rootDir}`;
  }

  async getReadRemote(ref: string): Promise<SandboxRepoRemote> {
    await this.ensureInitialized();
    return { fetchUrl: this.rootDir, ref };
  }

  async getWriteRemote(ref: string): Promise<SandboxRepoRemote> {
    await this.ensureInitialized();
    return { fetchUrl: this.rootDir, ref };
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await mkdir(this.rootDir, { recursive: true });
        const result = await runGit(this.rootDir, ["init", "--bare", "-q"]);
        if (!result.ok) {
          throw new Error(`failed to init bare scratch repo: ${result.stderr}`);
        }
      })();
    }
    return this.initialized;
  }
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
