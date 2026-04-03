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
    const repoInfo = await repo.info();
    const lookedUpRepo = await store.getRepoByName(repoInfo.owner, repoInfo.name);

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
      includePatch: true,
    });
    const mainReadme = await repo.readTextFile({ ref: "refs/heads/main", path: "README.md" });
    const missingFile = await repo.readTextFile({ ref: "refs/heads/main", path: "missing.txt" });

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
      includePatch: true,
    });
    const directFiles = await repo.listFiles(directCommit.branch);
    const directNestedFile = await repo.readTextFile({ ref: directCommit.branch, path: "nested/demo.ts" });
    const refs = await repo.listRefs();
    const branches = await repo.listBranches();
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
      repo: repoInfo,
      secondRepo: await secondRepo.info(),
      lookedUpRepo: lookedUpRepo ? await lookedUpRepo.info() : null,
      remote,
      secondRemote,
      readRemote,
      refs,
      branches,
      clientPush: {
        localHeadSha: clientHeadSha,
        resolvedRef: clientRef,
        diff: clientDiff,
        readme: mainReadme,
        missingFile,
      },
      directCommit: {
        result: directCommit,
        resolvedRef: directRef,
        diff: directDiff,
        files: directFiles,
        nestedFile: directNestedFile,
      },
      clone: {
        headSha: clonedHead,
        branches: clonedBranches,
      },
      checks: {
        mainResolved: mainRef !== null,
        repoLookupMatches: lookedUpRepo !== null && (await lookedUpRepo.info()).id === repoInfo.id,
        clientPushResolved: clientRef?.sha === clientHeadSha,
        clientDiffHasFile: clientDiff.files.some((file) => file.path === "client.txt"),
        clientDiffHasPatch: typeof clientDiff.patch === "string" && clientDiff.patch.includes("client.txt"),
        clientDiffHasStats:
          clientDiff.totalAdditions > 0 &&
          clientDiff.files.some((file) => file.path === "client.txt" && file.additions > 0),
        readTextFileWorks: mainReadme === "# integration repo",
        missingFileReturnsNull: missingFile === null,
        directCommitResolved: directRef?.sha === directCommit.commitSha,
        directDiffHasFile: directDiff.files.some((file) => file.path === "sdk.txt"),
        directDiffHasPatch: typeof directDiff.patch === "string" && directDiff.patch.includes("sdk.txt"),
        directListFilesIncludesNested: directFiles.paths.includes("nested/demo.ts"),
        directReadTextFileWorks: directNestedFile === 'export const mode = "sdk";',
        refsIncludeMetadata: refs.some((ref) => ref.name === "refs/heads/main" && !!ref.message && !!ref.timestamp),
        branchesIncludeShortNames: branches.some((branch) => branch.name === "main" && !!branch.message && !!branch.timestamp),
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
