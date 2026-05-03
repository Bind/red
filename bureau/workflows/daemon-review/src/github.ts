import { writeFile } from "node:fs/promises";
import { GitHubRepo } from "../../../repo";
import { runDaemonReviewWorkflow } from "../workflow";
import {
  buildReviewBody,
  classifyDaemonDiff,
  type InlineComment,
  parsePrFilePatchRanges,
  pushFixupBranch,
  type PrFileInfo,
} from "./proposals";
import type {
  DaemonReviewResult,
  GithubPrContext,
} from "./types";
import { reviewLogger } from "./logger";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function githubContextFromEnv(): GithubPrContext {
  const [owner, repo] = parseRepoFullName(requiredEnv("REPO"), "REPO");
  return {
    owner,
    repo,
    prNumber: Number.parseInt(requiredEnv("PR_NUMBER"), 10),
    githubToken: requiredEnv("GITHUB_TOKEN"),
    prHeadSha: requiredEnv("PR_HEAD_SHA"),
    prHeadRef: requiredEnv("PR_HEAD_REF"),
    prBaseSha: requiredEnv("PR_BASE_SHA"),
    prBaseRef: requiredEnv("PR_BASE_REF"),
    prHeadRepoFullName: requiredEnv("PR_HEAD_REPO"),
  };
}

function parseRepoFullName(value: string, envName: string): [string, string] {
  const [owner, repo] = value.split("/", 2);
  if (!owner || !repo) {
    throw new Error(`${envName} must be in owner/repo format`);
  }
  return [owner, repo];
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

function githubFixupRemote(owner: string, repo: string, githubToken: string) {
  return {
    fetchUrl: `https://github.com/${owner}/${repo}.git`,
    pushUrl: `https://github.com/${owner}/${repo}.git`,
    fetchGitConfigArgs: ["-c", `http.extraHeader=AUTHORIZATION: bearer ${githubToken}`],
    pushGitConfigArgs: ["-c", `http.extraHeader=AUTHORIZATION: bearer ${githubToken}`],
    branchUrl: (branchName: string) => `https://github.com/${owner}/${repo}/tree/${branchName}`,
  };
}

async function publishGithubProposals(
  context: GithubPrContext,
  execution: DaemonReviewResult,
): Promise<DaemonReviewResult["proposalArtifacts"]> {
  const editingOutcomes = execution.outcomes.filter(
    (outcome) => outcome.ok && outcome.diff.trim().length > 0,
  );
  if (editingOutcomes.length === 0) {
    return execution.proposalArtifacts ?? null;
  }

  const prFiles = await fetchPrFiles(
    context.githubToken,
    context.owner,
    context.repo,
    context.prNumber,
  );
  const classifications = editingOutcomes.map((outcome) =>
    classifyDaemonDiff(outcome.name, outcome.diff, prFiles),
  );
  const proposalArtifacts = {
    edits: execution.proposalArtifacts?.edits ?? [],
    classifications,
  };

  let fixup = null;
  try {
    fixup = await pushFixupBranch({
      remote: githubFixupRemote(context.owner, context.repo, context.githubToken),
      prNumber: context.prNumber,
      prHeadSha: context.prHeadSha,
      prHeadRef: context.prBaseRef,
      classifications,
      prPublisher: (input) =>
        ensureStackedGithubPr(context.githubToken, context.owner, context.repo, input),
    });
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

  return proposalArtifacts;
}

async function ensureStackedGithubPr(
  githubToken: string,
  owner: string,
  repo: string,
  input: {
    branchName: string;
    baseRef: string;
    prNumber: number;
    applied: Array<{ daemonName: string; files: string[] }>;
  },
): Promise<string> {
  const headers = {
    authorization: `Bearer ${githubToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "red-daemon-review",
  } as const;

  const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${input.branchName}&base=${encodeURIComponent(input.baseRef)}`;
  const listResponse = await fetch(listUrl, { headers });
  if (!listResponse.ok) {
    throw new Error(
      `failed to list stacked PRs for ${input.branchName}: ${listResponse.status} ${await listResponse.text()}`,
    );
  }
  const existingList = (await listResponse.json()) as Array<{ html_url: string }>;
  if (existingList.length > 0) {
    return existingList[0].html_url;
  }

  const bodyLines = [
    `Auto-generated by daemon-review for #${input.prNumber}.`,
    "",
    "Files touched:",
    ...input.applied.flatMap(({ daemonName, files }) =>
      files.map((file) => `- \`${daemonName}\`: \`${file}\``),
    ),
    "",
    `Merge this PR into \`${input.baseRef}\` to land the heals on top of #${input.prNumber}.`,
  ];

  const createResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: `Daemon fixup for #${input.prNumber}`,
        head: input.branchName,
        base: input.baseRef,
        body: bodyLines.join("\n"),
        maintainer_can_modify: true,
      }),
    },
  );
  if (!createResponse.ok) {
    throw new Error(
      `failed to create stacked PR ${input.branchName} → ${input.baseRef}: ${createResponse.status} ${await createResponse.text()}`,
    );
  }
  const created = (await createResponse.json()) as { html_url: string };
  return created.html_url;
}

export async function runGithubDaemonReview(context: GithubPrContext): Promise<DaemonReviewResult> {
  const changedFiles = await fetchChangedFiles(
    context.githubToken,
    context.owner,
    context.repo,
    context.prNumber,
  );
  const trunkRepo = new GitHubRepo({
    owner: context.owner,
    name: context.repo,
    token: context.githubToken,
  });
  const [headOwner, headRepo] = parseRepoFullName(context.prHeadRepoFullName, "PR_HEAD_REPO");
  const branchRepo = new GitHubRepo({
    owner: headOwner,
    name: headRepo,
    token: context.githubToken,
  });
  const workflow = await runDaemonReviewWorkflow({
    trunkRepo,
    branchRepo,
    baseRef: context.prBaseSha,
    headRef: context.prHeadSha,
    changedFiles,
    preserveSandbox: false,
    librarianModel: process.env.DAEMON_REVIEW_LIBRARIAN_MODEL,
  });
  const execution = workflow.execution;
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

  let proposalArtifacts: DaemonReviewResult["proposalArtifacts"] | null =
    execution.proposalArtifacts ?? null;
  try {
    proposalArtifacts = await publishGithubProposals(context, execution);
  } catch (error) {
    reviewLogger.error("daemon review proposal publishing failed", { error });
  }

  return {
    summary,
    outcomes: execution.outcomes,
    blockingFailures: execution.blockingFailures,
    proposalArtifacts: proposalArtifacts ?? null,
  };
}
