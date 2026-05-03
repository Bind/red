import { expect, test } from "bun:test";
import { canPublishStackedFixups, stackedFixupBaseRef } from "./github";
import type { GithubPrContext } from "./types";

test("stacked fixup PRs base off the PR head branch, not trunk", () => {
  const context: GithubPrContext = {
    owner: "Bind",
    repo: "red",
    prNumber: 43,
    githubToken: "token",
    prBaseSha: "base-sha",
    prBaseRef: "main",
    prHeadSha: "head-sha",
    prHeadRef: "feat/daemon-runner-refinement",
    prHeadRepoFullName: "Bind/red",
  };

  expect(stackedFixupBaseRef(context)).toBe("feat/daemon-runner-refinement");
});

test("stacked fixup branch publishing is disabled for fork PRs", () => {
  const context: GithubPrContext = {
    owner: "Bind",
    repo: "red",
    prNumber: 43,
    githubToken: "token",
    prBaseSha: "base-sha",
    prBaseRef: "main",
    prHeadSha: "head-sha",
    prHeadRef: "feature-branch",
    prHeadRepoFullName: "someone-else/red",
  };

  expect(canPublishStackedFixups(context)).toBe(false);
});
