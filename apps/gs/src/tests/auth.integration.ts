import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { startDevGitServer, runCommand } from "../core/dev-stack";
import { GitSdk } from "../core/git-sdk";

describe("git-sdk auth integration", () => {
  test("allows clone with read credentials and rejects push with read-only credentials", async () => {
    const server = await startDevGitServer();
    const runId = randomUUID().slice(0, 8);
    const writerDir = await mkdtemp(join(tmpdir(), "redc-gitty-auth-write-"));
    const readerCloneDir = await mkdtemp(join(tmpdir(), "redc-gitty-auth-read-"));

    try {
      const store = new GitSdk({
        publicUrl: server.publicUrl,
        defaultOwner: "redc",
        authTokenSecret: server.authTokenSecret,
      });

      const repo = await store.createRepo({
        owner: "redc",
        name: `auth-repo-${runId}`,
        defaultBranch: "main",
        visibility: "private",
      });

      const writeRemote = await repo.getRemoteUrl({
        actorId: "auth-test",
        access: "write",
      });
      const readRemote = await repo.getRemoteUrl({
        actorId: "auth-test",
        access: "read",
      });

      await runCommand("git", ["init"], { cwd: writerDir });
      await runCommand("git", ["config", "user.name", "auth test"], { cwd: writerDir });
      await runCommand("git", ["config", "user.email", "auth@redc.local"], { cwd: writerDir });
      await Bun.write(join(writerDir, "README.md"), "# auth repo\n");
      await runCommand("git", ["add", "README.md"], { cwd: writerDir });
      await runCommand("git", ["commit", "-m", "seed repo"], { cwd: writerDir });
      await runCommand("git", ["branch", "-M", "main"], { cwd: writerDir });
      await runCommand("git", ["remote", "add", "origin", writeRemote.pushUrl], { cwd: writerDir });
      await runCommand("git", ["push", "-u", "origin", "main"], { cwd: writerDir });

      await runCommand("git", ["clone", readRemote.fetchUrl, readerCloneDir]);
      await runCommand("git", ["-C", readerCloneDir, "config", "user.name", "read only"]);
      await runCommand("git", ["-C", readerCloneDir, "config", "user.email", "readonly@redc.local"]);
      await Bun.write(join(readerCloneDir, "readonly.txt"), "should not push\n");
      await runCommand("git", ["-C", readerCloneDir, "add", "readonly.txt"]);
      await runCommand("git", ["-C", readerCloneDir, "commit", "-m", "read only change"]);

      let pushError: unknown = null;
      try {
        await runCommand("git", ["-C", readerCloneDir, "push", "origin", "HEAD:refs/heads/read-only-fail"]);
      } catch (error) {
        pushError = error;
      }

      expect(pushError).not.toBeNull();
      expect(await repo.resolveRef("refs/heads/read-only-fail")).toBeNull();
    } finally {
      await rm(writerDir, { recursive: true, force: true });
      await rm(readerCloneDir, { recursive: true, force: true });
      await server.stop();
    }
  }, 120_000);
});
