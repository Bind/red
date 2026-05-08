import { expect, test } from "bun:test";
import { canPublishStackedFixups, renderRoutingDiagram, stackedFixupBaseRef } from "./github";
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

test("routing diagram prints file to daemon selections", () => {
  const diagram = renderRoutingDiagram([
    {
      file: "README.md",
      mode: "memory_embedding_librarian",
      selectedDaemons: ["docs-command-surface"],
      scores: [
        { daemonName: "docs-command-surface", finalScore: 0.9123, selected: true },
        { daemonName: "infra-audit", finalScore: 0.2444, selected: false },
      ],
    },
  ]);

  expect(diagram).toContain("README.md");
  expect(diagram).toContain("mode: memory_embedding_librarian");
  expect(diagram).toContain("selected: docs-command-surface");
  expect(diagram).toContain("* docs-command-surface 0.912");
  expect(diagram).toContain("- infra-audit 0.244");
});
