import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { startDevGitServer, runCommand, runCommandWithRetry } from "../core/dev-stack";
import { buildRemoteUrl } from "./http-test-helpers";

describe("native smart-http integration", () => {
  test("accepts the first push into a freshly created repo", async () => {
    const server = await startDevGitServer();
    const runId = randomUUID().slice(0, 8);
    const repoDir = await mkdtemp(join(tmpdir(), "redc-gitty-fresh-push-"));

    try {
      const repoId = `redc/fresh-push-${runId}`;
      const remote = buildRemoteUrl(server.publicUrl, server.authTokenSecret, repoId, "fresh-push-test", "write");

      await runCommand("git", ["init"], { cwd: repoDir });
      await runCommand("git", ["config", "user.name", "fresh push"], { cwd: repoDir });
      await runCommand("git", ["config", "user.email", "fresh-push@redc.local"], { cwd: repoDir });
      await Bun.write(join(repoDir, "README.md"), "# fresh push\n");
      await runCommand("git", ["add", "README.md"], { cwd: repoDir });
      await runCommand("git", ["commit", "-m", "seed repo"], { cwd: repoDir });
      await runCommand("git", ["branch", "-M", "main"], { cwd: repoDir });
      await runCommand("git", ["remote", "add", "origin", remote.pushUrl], { cwd: repoDir });

      await runCommandWithRetry("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

      const mainRef = await runCommand("git", ["-C", repoDir, "rev-parse", "HEAD"]);
      expect(mainRef.stdout.length).toBe(40);

      const lsRemote = await runCommandWithRetry("git", ["ls-remote", remote.fetchUrl]);
      expect(lsRemote.stdout).toContain("refs/heads/main");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await server.stop();
    }
  }, 120_000);
});
