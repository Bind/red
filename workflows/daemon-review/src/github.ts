import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildReviewBody,
  classifyDaemonDiff,
  type InlineComment,
  parsePrFilePatchRanges,
  pushFixupBranch,
  type PrFileInfo,
} from "./proposals";
import { runReviewExecution } from "./core";
import type {
  DaemonReviewResult,
  GithubPrContext,
  ProposalArtifacts,
} from "./types";
import { reviewLogger } from "./logger";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function githubContextFromEnv(): GithubPrContext {
  const [owner, repo] = requiredEnv("REPO").split("/");
  return {
    owner,
    repo,
    prNumber: Number.parseInt(requiredEnv("PR_NUMBER"), 10),
    trustedRoot: resolve(process.cwd()),
    reviewRoot: resolve(requiredEnv("REPO_ROOT")),
    githubToken: requiredEnv("GITHUB_TOKEN"),
    prHeadSha: requiredEnv("PR_HEAD_SHA"),
    prHeadRef: requiredEnv("PR_HEAD_REF"),
  };
}

export async function fetchChangedFiles(
  githubToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string[]> {
  const filenames: string[] = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${githubToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "red-daemon-review",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`failed to fetch PR files: ${response.status} ${await response.text()}`);
    }
    const pageFiles = (await response.json()) as Array<{ filename: string }>;
    filenames.push(...pageFiles.map((file) => file.filename));
    if (pageFiles.length < 100) break;
    page += 1;
  }

  return filenames;
}

export async function fetchPrFiles(
  githubToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<Map<string, PrFileInfo>> {
  const result = new Map<string, PrFileInfo>();
  let page = 1;
  while (true) {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${githubToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "red-daemon-review",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`failed to fetch PR files: ${response.status} ${await response.text()}`);
    }
    const pageFiles = (await response.json()) as Array<{
      filename: string;
      status: string;
      patch?: string;
    }>;
    for (const file of pageFiles) {
      result.set(file.filename, {
        filename: file.filename,
        status: file.status,
        ranges: file.patch ? parsePrFilePatchRanges(file.patch) : [],
      });
    }
    if (pageFiles.length < 100) break;
    page += 1;
  }
  return result;
}

export async function postProposalReview(
  githubToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
  daemonName: string,
  comments: InlineComment[],
  body: string,
): Promise<void> {
  if (comments.length === 0 && body.length === 0) return;
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "red-daemon-review",
      },
      body: JSON.stringify({ body, event: "COMMENT", comments }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `failed to post daemon review for ${daemonName}: ${response.status} ${await response.text()}`,
    );
  }
}

export async function runGithubDaemonReview(context: GithubPrContext): Promise<DaemonReviewResult> {
  const changedFiles = await fetchChangedFiles(
    context.githubToken,
    context.owner,
    context.repo,
    context.prNumber,
  );
  const execution = await runReviewExecution({
    trustedRoot: context.trustedRoot,
    reviewRoot: context.reviewRoot,
    changedFiles,
  });
  const summary = [
    "# Daemon Review",
    "",
    `PR: #${context.prNumber}`,
    execution.summary,
  ].join("\n");
  reviewLogger.info("daemon review summary\n{summary}", { summary });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  const editingOutcomes = execution.outcomes.filter(
    (outcome) => outcome.ok && outcome.diff.trim().length > 0,
  );
  let proposalArtifacts = execution.proposalArtifacts;
  if (editingOutcomes.length > 0) {
    try {
      const prFiles = await fetchPrFiles(
        context.githubToken,
        context.owner,
        context.repo,
        context.prNumber,
      );
      const classifications = editingOutcomes.map((outcome) =>
        classifyDaemonDiff(outcome.name, outcome.diff, prFiles),
      );
      proposalArtifacts = {
        edits: execution.proposalArtifacts?.edits ?? [],
        classifications,
      };
      let fixup = null;
      try {
        fixup = await pushFixupBranch(
          context.owner,
          context.repo,
          context.prNumber,
          context.prHeadSha,
          context.prHeadRef,
          classifications,
          context.githubToken,
        );
      } catch (error) {
        reviewLogger.error("daemon fixup branch push failed", { error });
      }
      for (const classification of classifications) {
        const body = buildReviewBody(classification, fixup);
        try {
          await postProposalReview(
            context.githubToken,
            context.owner,
            context.repo,
            context.prNumber,
            classification.daemonName,
            classification.inlineComments,
            body,
          );
        } catch (error) {
          reviewLogger.error("daemon review inline suggestions failed for {daemon}", {
            daemon: classification.daemonName,
            error,
          });
        }
      }
    } catch (error) {
      reviewLogger.error("daemon review proposal posting failed", { error });
    }
  }

  return {
    summary,
    outcomes: execution.outcomes,
    blockingFailures: execution.blockingFailures,
    proposalArtifacts: proposalArtifacts ?? null,
  };
}
