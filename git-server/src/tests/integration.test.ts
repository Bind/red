import { describe, expect, test } from "bun:test";
import { runIntegration } from "../integration/run-integration";

const maybeIntegrationTest = process.env.GIT_SERVER_RUN_INTEGRATION === "1" ? test : test.skip;

describe("git-sdk live integration", () => {
  maybeIntegrationTest("proves code.storage-style semantics on top of the live git server", async () => {
    const result = await runIntegration();

    expect(result.checks.mainResolved).toBe(true);
    expect(result.checks.clientPushResolved).toBe(true);
    expect(result.checks.clientDiffHasFile).toBe(true);
    expect(result.checks.directCommitResolved).toBe(true);
    expect(result.checks.directDiffHasFile).toBe(true);
    expect(result.checks.directListFilesIncludesNested).toBe(true);
    expect(result.checks.cloneMatchesMain).toBe(true);
    expect(result.checks.secondRepoResolved).toBe(true);
    expect(result.checks.secondRepoIsolated).toBe(true);
    expect(result.change.repoId).toStartWith("redc/integration-repo-");
  }, 120_000);
});
