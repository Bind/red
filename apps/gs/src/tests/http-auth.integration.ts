import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { startDevGitServer, runCommand, runCommandWithRetry } from "../core/dev-stack";
import { GitSdk } from "../core/git-sdk";
import { basicAuthHeader, fetchJson } from "./http-test-helpers";

describe("native HTTP auth integration", () => {
  test("enforces control-plane and smart-http auth parity", async () => {
    const server = await startDevGitServer();
    const runId = randomUUID().slice(0, 8);
    const repoDir = await mkdtemp(join(tmpdir(), "redc-gitty-auth-http-"));

    try {
      const store = new GitSdk({
        publicUrl: server.publicUrl,
        defaultOwner: "redc",
        authTokenSecret: server.authTokenSecret,
      });

      const repo = await store.createRepo({
        owner: "redc",
        name: `auth-http-${runId}`,
        defaultBranch: "main",
        visibility: "private",
      });
      const otherRepo = await store.createRepo({
        owner: "redc",
        name: `auth-http-other-${runId}`,
        defaultBranch: "main",
        visibility: "private",
      });
      const repoInfo = await repo.info();
      const otherRepoInfo = await otherRepo.info();

      const readRemote = await repo.getRemoteUrl({
        actorId: "auth-http-reader",
        ttlSeconds: 300,
        access: "read",
      });
      const writeRemote = await repo.getRemoteUrl({
        actorId: "auth-http-writer",
        ttlSeconds: 300,
        access: "write",
      });

      await runCommand("git", ["init"], { cwd: repoDir });
      await runCommand("git", ["config", "user.name", "auth http seed"], { cwd: repoDir });
      await runCommand("git", ["config", "user.email", "auth-http@redc.local"], { cwd: repoDir });
      await Bun.write(join(repoDir, "README.md"), "# auth http\n");
      await runCommand("git", ["add", "README.md"], { cwd: repoDir });
      await runCommand("git", ["commit", "-m", "seed auth http repo"], { cwd: repoDir });
      await runCommand("git", ["branch", "-M", "main"], { cwd: repoDir });
      await runCommand("git", ["remote", "add", "origin", writeRemote.pushUrl], { cwd: repoDir });
      await runCommandWithRetry("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: repoDir });

      const controlUrl = new URL(`/api/repos/${repoInfo.owner}/${repoInfo.name}`, server.publicUrl);
      const otherControlUrl = new URL(`/api/repos/${otherRepoInfo.owner}/${otherRepoInfo.name}`, server.publicUrl);
      const receivePackInfoRefs = new URL(`/${repoInfo.owner}/${repoInfo.name}.git/info/refs?service=git-receive-pack`, server.publicUrl);
      const uploadPackInfoRefs = new URL(`/${repoInfo.owner}/${repoInfo.name}.git/info/refs?service=git-upload-pack`, server.publicUrl);

      const noAuth = await fetch(controlUrl);
      expect(noAuth.status).toBe(401);

      const malformedAuth = await fetch(controlUrl, {
        headers: {
          Authorization: "Basic definitely-not-base64",
        },
      });
      expect(malformedAuth.status).toBe(401);

      const tamperedToken = `${writeRemote.password!.slice(0, -1)}x`;
      const tamperedAuth = await fetch(controlUrl, {
        headers: {
          Authorization: basicAuthHeader(writeRemote.username!, tamperedToken),
        },
      });
      expect(tamperedAuth.status).toBe(401);

      const repoMismatch = await fetch(otherControlUrl, {
        headers: {
          Authorization: basicAuthHeader(writeRemote.username!, writeRemote.password!),
        },
      });
      expect(repoMismatch.status).toBe(401);

      const readControl = await fetchJson<Record<string, unknown>>(controlUrl, {
        username: readRemote.username!,
        password: readRemote.password!,
      });
      expect(readControl.response.status).toBe(200);

      const readOnWriteService = await fetch(receivePackInfoRefs, {
        headers: {
          Authorization: basicAuthHeader(readRemote.username!, readRemote.password!),
        },
      });
      expect(readOnWriteService.status).toBe(401);

      const writeOnWriteService = await fetch(receivePackInfoRefs, {
        headers: {
          Authorization: basicAuthHeader(writeRemote.username!, writeRemote.password!),
        },
      });
      expect(writeOnWriteService.status).toBe(200);

      const adminControl = await fetchJson<Record<string, unknown>>(controlUrl, {
        username: server.adminUsername,
        password: server.adminPassword,
      });
      expect(adminControl.response.status).toBe(200);

      const adminUploadPack = await fetch(uploadPackInfoRefs, {
        headers: {
          Authorization: basicAuthHeader(server.adminUsername, server.adminPassword),
        },
      });
      expect(adminUploadPack.status).toBe(200);
      expect(adminUploadPack.headers.get("content-type")).toContain("application/x-git-upload-pack-advertisement");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await server.stop();
    }
  }, 120_000);
});
