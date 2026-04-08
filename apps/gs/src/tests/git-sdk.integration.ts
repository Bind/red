import { describe, expect, test } from "bun:test";
import { runIntegration } from "../integration/run-integration";

describe("git-sdk live integration", () => {
  test("proves code.storage-style semantics on top of the live git server", async () => {
    const result = await runIntegration();

    expect(result.checks.mainResolved).toBe(true);
    expect(result.checks.repoLookupMatches).toBe(true);
    expect(result.checks.clientPushResolved).toBe(true);
    expect(result.checks.clientDiffHasFile).toBe(true);
    expect(result.checks.clientDiffHasPatch).toBe(true);
    expect(result.checks.clientDiffHasPerFilePatch).toBe(true);
    expect(result.checks.clientDiffHasStats).toBe(true);
    expect(result.checks.readTextFileWorks).toBe(true);
    expect(result.checks.missingFileReturnsNull).toBe(true);
    expect(result.checks.badRefReadRejected).toBe(true);
    expect(result.checks.directCommitResolved).toBe(true);
    expect(result.checks.directDiffHasFile).toBe(true);
    expect(result.checks.directDiffHasPatch).toBe(true);
    expect(result.checks.directDiffHasPerFilePatch).toBe(true);
    expect(result.checks.directListFilesIncludesNested).toBe(true);
    expect(result.checks.directReadTextFileWorks).toBe(true);
    expect(result.checks.refsIncludeMetadata).toBe(true);
    expect(result.checks.branchesIncludeShortNames).toBe(true);
    expect(result.checks.cloneMatchesMain).toBe(true);
    expect(result.checks.secondRepoResolved).toBe(true);
    expect(result.checks.secondRepoIsolated).toBe(true);
    expect(result.change.repoId).toStartWith("redc/integration-repo-");
  }, 120_000);
});
