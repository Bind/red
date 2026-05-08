import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRepo } from "./repo";
import { remoteContainer } from "./sandbox-remote";

const TEST_IMAGE = "alpine/git:2.49.1";

let rootDir: string;
let dockerAvailable = false;

beforeAll(async () => {
  dockerAvailable = await canRun(["docker", "info"]);
  if (!dockerAvailable) return;
  await runOrThrow(["docker", "pull", TEST_IMAGE]);
}, 60_000);

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-remote-test-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("remoteContainer", () => {
  test("compiles to a BureauSandboxProvider with name 'remote-container'", () => {
    const provider = remoteContainer({ image: TEST_IMAGE });
    expect(provider.name).toBe("remote-container");
  });

  test("creates a docker-backed sandbox and clones a local repo into it", async () => {
    if (!dockerAvailable) return;

    const repoRoot = join(rootDir, "repo");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "README.md"), "remote clone works\n");
    await runOrThrow(["git", "init", "-q"], repoRoot);
    await runOrThrow(["git", "add", "-A"], repoRoot);
    await runOrThrow(
      [
        "git",
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "baseline",
      ],
      repoRoot,
    );

    const provider = remoteContainer({ image: TEST_IMAGE });
    const session = await provider.create({ preserve: false });
    expect(session.name).toBe("remote-container");

    const clone = await session.clone({
      repo: new LocalRepo({ root: repoRoot }),
      ref: "HEAD",
      dest: "review",
    });
    const readme = await readFile(join(clone.root, "README.md"), "utf8");
    expect(readme).toContain("remote clone works");

    await session.cleanup();
    expect(existsSync(session.root)).toBe(false);
  }, 60_000);

  test("prepare copies the workspace while excluding heavy/generated directories", async () => {
    if (!dockerAvailable) return;

    const sourceRoot = join(rootDir, "source");
    await mkdir(join(sourceRoot, ".git"), { recursive: true });
    await mkdir(join(sourceRoot, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await writeFile(join(sourceRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(sourceRoot, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    await writeFile(join(sourceRoot, "src", "index.ts"), "export const ok = true;\n");

    const provider = remoteContainer({ image: TEST_IMAGE });
    const workspace = await provider.prepare({
      sourceRoot,
      cwd: join(sourceRoot, "src"),
      preserve: false,
    });

    expect(await readFile(join(workspace.root, "src", "index.ts"), "utf8")).toContain("ok");
    expect(existsSync(join(workspace.root, ".git"))).toBe(false);
    expect(existsSync(join(workspace.root, "node_modules"))).toBe(false);
    expect(workspace.cwd).toBe(join(workspace.root, "src"));

    await workspace.cleanup();
    expect(existsSync(workspace.root)).toBe(false);
  }, 60_000);
});

async function canRun(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function runOrThrow(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${stderr || stdout}`);
  }
}
