#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryChangeStore } from "../core/change-store";
import { startDevGitServer, runCommand } from "../core/dev-stack";
import { GitSdk } from "../core/git-sdk";

export async function runIntegration() {
  const server = await startDevGitServer();
  const runId = randomUUID().slice(0, 8);
  const clientDir = await mkdtemp(join(tmpdir(), "redc-gitty-client-"));
  const cloneDir = await mkdtemp(join(tmpdir(), "redc-gitty-clone-"));
  const secondClientDir = await mkdtemp(join(tmpdir(), "redc-gitty-client-two-"));

  try {
    const store = new GitSdk({
      publicUrl: server.publicUrl,
      defaultOwner: "redc",
      authTokenSecret: server.authTokenSecret,
    });

    const repo = await store.createRepo({
      owner: "redc",
      name: `integration-repo-${runId}`,
      defaultBranch: "main",
      visibility: "private",
    });

    const secondRepo = await store.createRepo({
      owner: "redc",
      name: `integration-repo-two-${runId}`,
      defaultBranch: "main",
      visibility: "private",
    });

    const remote = await repo.getRemoteUrl({
      actorId: "integration-test",
      ttlSeconds: 300,
    });
    const secondRemote = await secondRepo.getRemoteUrl({
      actorId: "integration-test",
      ttlSeconds: 300,
    });
    const readRemote = await repo.getRemoteUrl({
      actorId: "integration-test",
      ttlSeconds: 300,
      access: "read",
    });

    await runCommand("git", ["init"], { cwd: clientDir });
    await runCommand("git", ["config", "user.name", "integration client"], { cwd: clientDir });
    await runCommand("git", ["config", "user.email", "integration@redc.local"], { cwd: clientDir });
    await Bun.write(join(clientDir, "README.md"), "# integration repo\n");
    await runCommand("git", ["add", "README.md"], { cwd: clientDir });
    await runCommand("git", ["commit", "-m", "initial client commit"], { cwd: clientDir });
    await runCommand("git", ["branch", "-M", "main"], { cwd: clientDir });
    await runCommand("git", ["remote", "add", "origin", remote.pushUrl], { cwd: clientDir });
    await runCommand("git", ["push", "-u", "origin", "main"], { cwd: clientDir });

    await runCommand("git", ["init"], { cwd: secondClientDir });
    await runCommand("git", ["config", "user.name", "integration client two"], { cwd: secondClientDir });
    await runCommand("git", ["config", "user.email", "integration2@redc.local"], { cwd: secondClientDir });
    await Bun.write(join(secondClientDir, "SECOND.md"), "# second repo\n");
    await runCommand("git", ["add", "SECOND.md"], { cwd: secondClientDir });
    await runCommand("git", ["commit", "-m", "initial second commit"], { cwd: secondClientDir });
    await runCommand("git", ["branch", "-M", "main"], { cwd: secondClientDir });
    await runCommand("git", ["remote", "add", "origin", secondRemote.pushUrl], { cwd: secondClientDir });
    await runCommand("git", ["push", "-u", "origin", "main"], { cwd: secondClientDir });

    await runCommand("git", ["checkout", "-b", "feature/client-push"], { cwd: clientDir });
    await Bun.write(join(clientDir, "client.txt"), "client path\n");
    await runCommand("git", ["add", "client.txt"], { cwd: clientDir });
    await runCommand("git", ["commit", "-m", "client push change"], { cwd: clientDir });
    await runCommand("git", ["push", "origin", "HEAD:refs/heads/feature/client-push"], { cwd: clientDir });
    const clientHeadSha = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: clientDir })).stdout;

    const mainRef = await repo.resolveRef("refs/heads/main");
    const clientRef = await repo.resolveRef("refs/heads/feature/client-push");
    const clientDiff = await repo.getCommitDiff({
      baseRef: "refs/heads/main",
      headRef: "refs/heads/feature/client-push",
    });

    const directCommit = await repo
      .createCommit({
        branch: "refs/heads/feature/direct-sdk",
        message: "direct sdk commit",
        author: {
          name: "sdk writer",
          email: "sdk@redc.local",
        },
      })
      .put("sdk.txt", "sdk path\n")
      .put("nested/demo.ts", 'export const mode = "sdk";\n')
      .send();

    const directRef = await repo.resolveRef(directCommit.branch);
    const directDiff = await repo.getCommitDiff({
      baseRef: "refs/heads/main",
      headRef: directCommit.branch,
    });
    const directFiles = await repo.listFiles(directCommit.branch);
    const secondMain = await secondRepo.resolveRef("refs/heads/main");
    const secondFiles = await secondRepo.listFiles("refs/heads/main");

    await rm(cloneDir, { recursive: true, force: true });
    await runCommand("git", ["clone", readRemote.fetchUrl, cloneDir]);
    const clonedHead = (await runCommand("git", ["-C", cloneDir, "rev-parse", "HEAD"])).stdout;
    const clonedBranches = (await runCommand("git", ["-C", cloneDir, "branch", "-a"])).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const changes = new InMemoryChangeStore();
    const change = await changes.create({
      repoId: (await repo.info()).id,
      baseRef: "refs/heads/main",
      headRef: "refs/heads/feature/client-push",
      status: "draft",
    });

    return {
      server: {
        publicUrl: server.publicUrl,
      },
      repo: await repo.info(),
      secondRepo: await secondRepo.info(),
      remote,
      secondRemote,
      readRemote,
      clientPush: {
        localHeadSha: clientHeadSha,
        resolvedRef: clientRef,
        diff: clientDiff,
      },
      directCommit: {
        result: directCommit,
        resolvedRef: directRef,
        diff: directDiff,
        files: directFiles,
      },
      clone: {
        headSha: clonedHead,
        branches: clonedBranches,
      },
      checks: {
        mainResolved: mainRef !== null,
        clientPushResolved: clientRef?.sha === clientHeadSha,
        clientDiffHasFile: clientDiff.files.some((file) => file.path === "client.txt"),
        directCommitResolved: directRef?.sha === directCommit.commitSha,
        directDiffHasFile: directDiff.files.some((file) => file.path === "sdk.txt"),
        directListFilesIncludesNested: directFiles.paths.includes("nested/demo.ts"),
        cloneMatchesMain: clonedHead === mainRef?.sha,
        secondRepoResolved: secondMain !== null,
        secondRepoIsolated: secondFiles.paths.includes("SECOND.md") && !secondFiles.paths.includes("README.md"),
      },
      change,
    };
  } finally {
    await rm(clientDir, { recursive: true, force: true });
    await rm(cloneDir, { recursive: true, force: true });
    await rm(secondClientDir, { recursive: true, force: true });
    await server.stop();
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runIntegration(), null, 2));
}
