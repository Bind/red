#!/usr/bin/env bun

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  loadMemorySnapshot,
  resolveDaemon,
  runDaemon,
  type CompleteFinding,
  type Proposal,
} from "../../../pkg/daemons/src/index";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

type DaemonOutcome = {
  name: string;
  ok: boolean;
  summary: string;
  findings: CompleteFinding[];
  reason?: string;
  message?: string;
  proposals: Proposal[];
};

type DaemonReviewConfig = {
  authorityPaths: string[];
  maxTurns: number;
};

function reviewParallelism(totalDaemons: number): number {
  const raw = process.env.DAEMON_REVIEW_MAX_PARALLEL;
  const parsed = raw ? Number.parseInt(raw, 10) : 3;
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(totalDaemons, parsed);
}

const DOC_SURFACE_PATHS = [
  "README.md",
  "justfile",
  "scripts/redc",
  "apps/ctl/cli/",
];

const INFRA_PATHS = [
  "infra/",
  "docs/dev-preview.md",
  "docs/release.md",
  "docs/base-image.md",
  "docs/secrets.md",
  ".github/workflows/preview-deploy.yml",
  ".github/workflows/release.yml",
  ".github/workflows/build-images.yml",
  ".agents/skills/debug-preview/",
];

const DAEMON_CONFIG: Record<string, DaemonReviewConfig> = {
  "docs-command-surface": {
    authorityPaths: ["README.md", "justfile", "scripts/redc", "apps/ctl/cli/"],
    maxTurns: 12,
  },
  "compose-contract": {
    authorityPaths: [
      "infra/base/",
      "infra/dev/",
      "infra/preview/",
      "infra/prod/",
      "infra/platform/caddy/",
      "infra/platform/gateway/",
      "justfile",
    ],
    maxTurns: 18,
  },
  "environment-boundaries": {
    authorityPaths: [
      "infra/AGENTS.md",
      "infra/base/",
      "infra/dev/",
      "infra/preview/",
      "infra/prod/",
      "infra/platform/",
      "docs/dev-preview.md",
      "docs/release.md",
      "docs/base-image.md",
      "docs/secrets.md",
      ".agents/skills/debug-preview/",
      "justfile",
    ],
    maxTurns: 18,
  },
  "infra-audit": {
    authorityPaths: [
      "infra/",
      "docs/dev-preview.md",
      "docs/release.md",
      "docs/base-image.md",
      "docs/secrets.md",
      "justfile",
      "sst.config.ts",
    ],
    maxTurns: 18,
  },
};

async function fetchChangedFiles(
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
          "user-agent": "redc-daemon-review",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`failed to fetch PR files: ${response.status} ${await response.text()}`);
    }
    const pageFiles = (await response.json()) as Array<{ filename: string }>;
    filenames.push(...pageFiles.map((file) => file.filename));
    if (pageFiles.length < 100) {
      break;
    }
    page += 1;
  }

  return filenames;
}

function matchesAnyPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function selectDaemons(changedFiles: string[]): string[] {
  const selected = new Set<string>();

  if (changedFiles.some((path) => matchesAnyPrefix(path, DOC_SURFACE_PATHS))) {
    selected.add("docs-command-surface");
  }

  if (changedFiles.some((path) => matchesAnyPrefix(path, INFRA_PATHS))) {
    selected.add("compose-contract");
    selected.add("environment-boundaries");
    selected.add("infra-audit");
  }

  return [...selected];
}

async function syncTrustedDaemonIntoPrCheckout(
  daemonName: string,
  trustedRoot: string,
  prRoot: string,
): Promise<void> {
  const spec = await resolveDaemon(daemonName, trustedRoot);
  const rel = relative(trustedRoot, spec.file);
  const dest = join(prRoot, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, await readFile(spec.file));
}

function renderOutcome(outcome: DaemonOutcome): string {
  const lines = [`### ${outcome.name}`];
  if (!outcome.ok) {
    lines.push(`- status: failed`);
    lines.push(`- reason: ${outcome.reason ?? "unknown"}`);
    lines.push(`- message: ${outcome.message ?? "daemon failed"}`);
    return lines.join("\n");
  }

  lines.push(`- status: completed`);
  lines.push(`- summary: ${outcome.summary}`);
  if (outcome.findings.length === 0) {
    lines.push(`- findings: none`);
    return lines.join("\n");
  }

  lines.push(`- findings:`);
  for (const finding of outcome.findings) {
    const target = finding.target ? ` (${finding.target})` : "";
    const note = finding.note ? `: ${finding.note}` : "";
    lines.push(`  - ${finding.invariant}${target} -> ${finding.status}${note}`);
  }
  if (outcome.proposals.length > 0) {
    const files = new Set(outcome.proposals.map((p) => p.file));
    lines.push(`- proposals: ${outcome.proposals.length} edit(s) across ${files.size} file(s)`);
  }
  return lines.join("\n");
}

function proposalModeEnabled(): boolean {
  return process.env.DAEMON_REVIEW_PROPOSAL_MODE === "true";
}

async function copyRepoTree(source: string, dest: string): Promise<void> {
  await cp(source, dest, {
    recursive: true,
    filter: (path) => !path.endsWith("/.git") && !path.includes("/.git/"),
  });
}

function matchAuthorityPaths(paths: string[], authorityPaths: string[]): string[] {
  return uniqueSorted(paths.filter((path) => matchesAnyPrefix(path, authorityPaths)));
}

async function buildDaemonReviewInput(
  daemonName: string,
  prRoot: string,
  changedFiles: string[],
): Promise<string> {
  const config = DAEMON_CONFIG[daemonName] ?? { authorityPaths: [], maxTurns: 18 };
  const relevantChangedFiles =
    config.authorityPaths.length > 0
      ? matchAuthorityPaths(changedFiles, config.authorityPaths)
      : uniqueSorted(changedFiles);
  const snapshot = await loadMemorySnapshot(daemonName, prRoot);
  const unchangedAuthorityFiles = snapshot
    ? matchAuthorityPaths(
        snapshot.unchangedFiles.map((file) => file.path),
        config.authorityPaths,
      )
    : [];
  const changedAuthorityFiles = snapshot
    ? matchAuthorityPaths(
        [...snapshot.changedFiles, ...snapshot.newFiles, ...snapshot.changedScopeFiles].map((file) => file.path),
        config.authorityPaths,
      )
    : [];
  const lines = [
    "PR review guidance:",
    "- Start with the changed files listed below.",
    "- Treat the listed authority files as the default source of truth.",
    "- Do not explore outside that set unless a specific mismatch requires it.",
    "- Prefer file reads over shell commands.",
    "- Once one clear mismatch explains an invariant, classify it and move on.",
  ];

  if (proposalModeEnabled()) {
    lines.push(
      "- Proposal mode is active: when you can confidently apply a heal, register it via the `propose` tool with structured (file, line, replacement) data. Proposals are surfaced as inline review suggestions; the real checkout is not modified.",
    );
  }

  lines.push("", "Changed files relevant to this daemon:");
  for (const path of relevantChangedFiles.length > 0 ? relevantChangedFiles : ["(none matched authority paths)"]) {
    lines.push(`- ${path}`);
  }

  if (config.authorityPaths.length > 0) {
    lines.push("", "Authority files and paths for this daemon:");
    for (const path of config.authorityPaths) lines.push(`- ${path}`);
  }

  if (unchangedAuthorityFiles.length > 0) {
    lines.push("", "Authority files unchanged since the nearest verified snapshot:");
    for (const path of unchangedAuthorityFiles) lines.push(`- ${path}`);
  }

  if (changedAuthorityFiles.length > 0) {
    lines.push("", "Authority files changed or newly present since the nearest verified snapshot:");
    for (const path of changedAuthorityFiles) lines.push(`- ${path}`);
  }

  if (snapshot?.staleTrackedSubjects.length) {
    lines.push("", "Tracked subjects invalidated since the nearest verified snapshot:");
    for (const subject of snapshot.staleTrackedSubjects.slice(0, 12)) lines.push(`- ${subject}`);
  }

  return lines.join("\n");
}

async function runSingleDaemon(
  daemonName: string,
  prRoot: string,
  changedFiles: string[],
): Promise<DaemonOutcome> {
  const proposalMode = proposalModeEnabled();
  const workingRoot = proposalMode
    ? await mkdtemp(join(tmpdir(), `daemon-review-${daemonName}-`))
    : prRoot;
  const reviewInput = await buildDaemonReviewInput(daemonName, prRoot, changedFiles);
  const config = DAEMON_CONFIG[daemonName] ?? { authorityPaths: [], maxTurns: 18 };

  if (proposalMode) {
    await copyRepoTree(prRoot, workingRoot);
  }

  console.log(`running daemon ${daemonName} against ${workingRoot}`);
  const result = await runDaemon(daemonName, {
    root: workingRoot,
    input: reviewInput,
    maxTurns: config.maxTurns,
    maxWallclockMs: 180_000,
  });

  if (proposalMode) {
    await rm(workingRoot, { recursive: true, force: true });
  }

  if (result.ok === false) {
    return {
      name: daemonName,
      ok: false,
      summary: "",
      findings: [],
      proposals: [],
      reason: result.reason,
      message: result.message,
    };
  }

  return {
    name: daemonName,
    ok: true,
    summary: result.payload.summary,
    findings: result.payload.findings,
    proposals: result.proposals,
  };
}

async function runDaemonsInParallel(
  daemonNames: string[],
  prRoot: string,
  changedFiles: string[],
): Promise<DaemonOutcome[]> {
  const outcomes = new Array<DaemonOutcome>(daemonNames.length);
  const parallelism = reviewParallelism(daemonNames.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      if (index >= daemonNames.length) return;
      nextIndex += 1;
      outcomes[index] = await runSingleDaemon(daemonNames[index], prRoot, changedFiles);
    }
  }

  await Promise.all(Array.from({ length: parallelism }, () => worker()));
  return outcomes;
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
} | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: match[2] ? Number.parseInt(match[2], 10) : 1,
    newStart: Number.parseInt(match[3], 10),
    newCount: match[4] ? Number.parseInt(match[4], 10) : 1,
  };
}

function parsePrFilePatchRanges(patch: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of patch.split("\n")) {
    const header = parseHunkHeader(line);
    if (!header) continue;
    if (header.newCount === 0) continue;
    ranges.push({ start: header.newStart, end: header.newStart + header.newCount - 1 });
  }
  return ranges;
}

type PrFileInfo = {
  filename: string;
  status: string;
  ranges: Array<{ start: number; end: number }>;
};

async function fetchPrFiles(
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
          "user-agent": "redc-daemon-review",
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

type InlineComment = {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
};

type ClassifiedProposal = {
  daemonName: string;
  inlineComments: InlineComment[];
  fixupTargets: Proposal[];
};

function buildInlineComment(daemonName: string, proposal: Proposal): InlineComment {
  const reasonBlock = proposal.reason ? `\n_${proposal.reason}_\n` : "";
  const body = [
    `Daemon \`${daemonName}\` suggests:${reasonBlock}`,
    "```suggestion",
    proposal.replacement,
    "```",
  ].join("\n");
  const comment: InlineComment = {
    path: proposal.file,
    line: proposal.endLine,
    side: "RIGHT",
    body,
  };
  if (proposal.endLine > proposal.line) {
    comment.start_line = proposal.line;
    comment.start_side = "RIGHT";
  }
  return comment;
}

function rangeContains(
  outer: { start: number; end: number },
  inner: { start: number; end: number },
): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function classifyProposalForInline(
  daemonName: string,
  proposals: Proposal[],
  prFiles: Map<string, PrFileInfo>,
): ClassifiedProposal {
  const inlineComments: InlineComment[] = [];
  const fixupTargets: Proposal[] = [];
  for (const proposal of proposals) {
    const prInfo = prFiles.get(proposal.file);
    const target = { start: proposal.line, end: proposal.endLine };
    const inHunk =
      prInfo !== undefined && prInfo.ranges.some((range) => rangeContains(range, target));
    if (inHunk) {
      inlineComments.push(buildInlineComment(daemonName, proposal));
    } else {
      fixupTargets.push(proposal);
    }
  }
  return { daemonName, inlineComments, fixupTargets };
}

async function postProposalReview(
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
        "user-agent": "redc-daemon-review",
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

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return { ok: true, stdout };
  return { ok: false, stdout, stderr };
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function applyProposalToFile(filePath: string, proposal: Proposal): Promise<void> {
  const original = await readFile(filePath, "utf8");
  const lines = original.split("\n");
  if (proposal.line < 1 || proposal.endLine > lines.length) {
    throw new Error(
      `proposal lines ${proposal.line}-${proposal.endLine} out of range for ${proposal.file} (file has ${lines.length} lines)`,
    );
  }
  const before = lines.slice(0, proposal.line - 1);
  const after = lines.slice(proposal.endLine);
  const replacement = proposal.replacement === "" ? [] : proposal.replacement.split("\n");
  await writeFile(filePath, [...before, ...replacement, ...after].join("\n"));
}

type FixupContribution = { daemonName: string; proposal: Proposal };

type FixupResult = {
  branchName: string;
  branchUrl: string;
  stackedPrUrl: string | null;
  stackedPrTrace: string[];
  applied: FixupContribution[];
  skipped: Array<{ contribution: FixupContribution; reason: string }>;
};

function orderForApply(contributions: FixupContribution[]): FixupContribution[] {
  return [...contributions].sort((a, b) => {
    if (a.proposal.file !== b.proposal.file) {
      return a.proposal.file < b.proposal.file ? -1 : 1;
    }
    return b.proposal.line - a.proposal.line;
  });
}

type StackedPrAttempt = {
  url: string | null;
  trace: string[];
};

async function ensureStackedPr(
  owner: string,
  repo: string,
  branchName: string,
  baseRef: string,
  prNumber: number,
  contributions: FixupContribution[],
  githubToken: string,
): Promise<StackedPrAttempt> {
  const headers = {
    authorization: `Bearer ${githubToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "redc-daemon-review",
  } as const;
  const trace: string[] = [];
  trace.push(`branch=${branchName}`);
  trace.push(`baseRef=${baseRef}`);

  const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branchName}&base=${encodeURIComponent(baseRef)}`;
  trace.push(`LIST ${listUrl}`);
  const listResponse = await fetch(listUrl, { headers });
  trace.push(`LIST status=${listResponse.status}`);
  if (!listResponse.ok) {
    const text = await listResponse.text();
    trace.push(`LIST body=${text.slice(0, 400)}`);
    return { url: null, trace };
  }
  const existingList = (await listResponse.json()) as Array<{ html_url?: string; number?: number }>;
  trace.push(`LIST count=${existingList.length}`);
  if (existingList.length > 0) {
    trace.push(`LIST first=${JSON.stringify(existingList[0]).slice(0, 200)}`);
    const url = existingList[0].html_url ?? null;
    return { url, trace };
  }

  const bodyLines = [
    `Auto-generated by daemon-review for #${prNumber}.`,
    "",
    "Heals applied:",
    ...contributions.map(
      ({ daemonName, proposal }) =>
        `- \`${daemonName}\`: \`${proposal.file}\`:${proposal.line}${
          proposal.endLine !== proposal.line ? `-${proposal.endLine}` : ""
        }${proposal.reason ? ` — ${proposal.reason}` : ""}`,
    ),
    "",
    `Merge this PR into \`${baseRef}\` to land the heals on top of #${prNumber}.`,
  ];

  trace.push(`CREATE head=${branchName} base=${baseRef}`);
  const createResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: `Daemon fixup for #${prNumber}`,
        head: branchName,
        base: baseRef,
        body: bodyLines.join("\n"),
        maintainer_can_modify: true,
      }),
    },
  );
  trace.push(`CREATE status=${createResponse.status}`);
  if (!createResponse.ok) {
    const text = await createResponse.text();
    trace.push(`CREATE body=${text.slice(0, 400)}`);
    return { url: null, trace };
  }
  const created = (await createResponse.json()) as { html_url?: string };
  trace.push(`CREATE response=${JSON.stringify(created).slice(0, 200)}`);
  return { url: created.html_url ?? null, trace };
}

async function pushFixupBranch(
  owner: string,
  repo: string,
  prNumber: number,
  prHeadSha: string,
  prHeadRef: string,
  contributions: FixupContribution[],
  githubToken: string,
): Promise<FixupResult | null> {
  if (contributions.length === 0) return null;

  const branchName = `claude/daemon-fixup-pr-${prNumber}`;
  const fixupRoot = await mkdtemp(join(tmpdir(), `daemon-fixup-${prNumber}-`));
  const remoteUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;

  await gitOrThrow(fixupRoot, ["init", "-q"]);
  await gitOrThrow(fixupRoot, ["remote", "add", "origin", remoteUrl]);
  await gitOrThrow(fixupRoot, ["fetch", "--depth", "1", "origin", prHeadSha]);
  await gitOrThrow(fixupRoot, ["checkout", "-b", branchName, prHeadSha]);

  const applied: FixupContribution[] = [];
  const skipped: Array<{ contribution: FixupContribution; reason: string }> = [];
  for (const contribution of orderForApply(contributions)) {
    const target = join(fixupRoot, contribution.proposal.file);
    try {
      await applyProposalToFile(target, contribution.proposal);
      applied.push(contribution);
    } catch (error) {
      skipped.push({
        contribution,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (applied.length === 0) {
    await rm(fixupRoot, { recursive: true, force: true });
    return null;
  }

  const messageLines = [`Daemon fixup for PR #${prNumber}`, ""];
  for (const { daemonName, proposal } of applied) {
    messageLines.push(
      `- ${daemonName}: ${proposal.file}:${proposal.line}${
        proposal.endLine !== proposal.line ? `-${proposal.endLine}` : ""
      }${proposal.reason ? ` — ${proposal.reason}` : ""}`,
    );
  }
  await gitOrThrow(fixupRoot, [
    "-c",
    "user.email=daemon-fixup@local",
    "-c",
    "user.name=daemon-fixup",
    "commit",
    "-am",
    messageLines.join("\n"),
  ]);
  await gitOrThrow(fixupRoot, ["push", "--force", "origin", branchName]);
  await rm(fixupRoot, { recursive: true, force: true });

  let stackedPrUrl: string | null = null;
  let stackedPrTrace: string[] = [];
  try {
    const attempt = await ensureStackedPr(
      owner,
      repo,
      branchName,
      prHeadRef,
      prNumber,
      applied,
      githubToken,
    );
    stackedPrUrl = attempt.url;
    stackedPrTrace = attempt.trace;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stackedPrTrace = [`THROW ${message}`];
    console.error("failed to ensure stacked fixup PR:", error);
  }

  return {
    branchName,
    branchUrl: `https://github.com/${owner}/${repo}/tree/${branchName}`,
    stackedPrUrl,
    stackedPrTrace,
    applied,
    skipped,
  };
}

function buildReviewBody(
  daemonName: string,
  inlineCount: number,
  daemonFixupApplied: FixupContribution[],
  fixup: FixupResult | null,
): string {
  const lines: string[] = [];
  if (inlineCount > 0) {
    lines.push(
      `Daemon \`${daemonName}\` posted ${inlineCount} inline healing suggestion${inlineCount === 1 ? "" : "s"}.`,
    );
  }
  if (daemonFixupApplied.length > 0 && fixup) {
    const target = fixup.stackedPrUrl
      ? `stacked PR ${fixup.stackedPrUrl}`
      : `branch [\`${fixup.branchName}\`](${fixup.branchUrl})`;
    lines.push(
      "",
      `${daemonFixupApplied.length} additional heal${daemonFixupApplied.length === 1 ? "" : "s"} fall outside this PR's diff hunks and have been committed to ${target}:`,
      "",
      ...daemonFixupApplied.map(
        ({ proposal }) =>
          `- \`${proposal.file}\`:${proposal.line}${
            proposal.endLine !== proposal.line ? `-${proposal.endLine}` : ""
          }${proposal.reason ? ` — ${proposal.reason}` : ""}`,
      ),
    );
    if (fixup.stackedPrTrace.length > 0) {
      lines.push(
        "",
        `<details><summary>Stacked PR trace (debug)</summary>`,
        "",
        "```",
        ...fixup.stackedPrTrace,
        "```",
        "</details>",
      );
    }
  }
  return lines.join("\n");
}

async function main() {
  const [owner, repo] = requiredEnv("REPO").split("/");
  const prNumber = Number.parseInt(requiredEnv("PR_NUMBER"), 10);
  const trustedRoot = resolve(process.cwd());
  const prRoot = resolve(requiredEnv("REPO_ROOT"));
  const githubToken = requiredEnv("GITHUB_TOKEN");
  const changedFiles = await fetchChangedFiles(githubToken, owner, repo, prNumber);
  const daemonNames = selectDaemons(changedFiles);

  if (daemonNames.length === 0) {
    const summary = "No matching daemons for this PR diff.";
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    }
    return;
  }

  for (const daemonName of daemonNames) {
    await syncTrustedDaemonIntoPrCheckout(daemonName, trustedRoot, prRoot);
  }

  const outcomes = await runDaemonsInParallel(daemonNames, prRoot, changedFiles);

  const summaryLines = [
    "# Daemon Review",
    "",
    `PR: #${prNumber}`,
    `Changed files: ${changedFiles.length}`,
    `Daemons: ${daemonNames.join(", ")}`,
    `Parallelism: ${reviewParallelism(daemonNames.length)}`,
    "",
    ...outcomes.map(renderOutcome),
    "",
  ];

  const summary = summaryLines.join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  const proposingOutcomes = outcomes.filter(
    (outcome) => outcome.ok && outcome.proposals.length > 0,
  );
  if (proposingOutcomes.length > 0) {
    try {
      const prFiles = await fetchPrFiles(githubToken, owner, repo, prNumber);
      const classifications = proposingOutcomes.map((outcome) =>
        classifyProposalForInline(outcome.name, outcome.proposals, prFiles),
      );
      const allFixupContributions: FixupContribution[] = classifications.flatMap((c) =>
        c.fixupTargets.map((proposal) => ({ daemonName: c.daemonName, proposal })),
      );
      let fixup: FixupResult | null = null;
      try {
        fixup = await pushFixupBranch(
          owner,
          repo,
          prNumber,
          requiredEnv("PR_HEAD_SHA"),
          requiredEnv("PR_HEAD_REF"),
          allFixupContributions,
          githubToken,
        );
      } catch (error) {
        console.error("daemon fixup branch push failed:", error);
      }
      try {
        const diagSections = [
          "## daemon-review diagnostic (debug)",
          "",
          "```",
          `fixup is null: ${fixup === null}`,
          `fixup.applied count: ${fixup?.applied.length ?? 0}`,
          `fixup.stackedPrUrl: ${fixup?.stackedPrUrl ?? "<null>"}`,
          `fixup.stackedPrTrace length: ${fixup?.stackedPrTrace.length ?? 0}`,
          "stackedPrTrace:",
          ...(fixup?.stackedPrTrace ?? []).map((line) => `  ${line}`),
          "```",
        ];
        await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${githubToken}`,
              accept: "application/vnd.github+json",
              "content-type": "application/json",
              "user-agent": "redc-daemon-review",
            },
            body: JSON.stringify({ body: diagSections.join("\n") }),
          },
        );
      } catch (error) {
        console.error("diagnostic comment failed:", error);
      }
      const appliedByDaemon = new Map<string, FixupContribution[]>();
      for (const contribution of fixup?.applied ?? []) {
        const list = appliedByDaemon.get(contribution.daemonName) ?? [];
        list.push(contribution);
        appliedByDaemon.set(contribution.daemonName, list);
      }
      for (const classification of classifications) {
        const applied = appliedByDaemon.get(classification.daemonName) ?? [];
        const body = buildReviewBody(
          classification.daemonName,
          classification.inlineComments.length,
          applied,
          fixup,
        );
        try {
          await postProposalReview(
            githubToken,
            owner,
            repo,
            prNumber,
            classification.daemonName,
            classification.inlineComments,
            body,
          );
        } catch (error) {
          console.error(
            `daemon review inline suggestions failed for ${classification.daemonName}:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error("daemon review proposal posting failed:", error);
    }
  }

  const blockingFailures = outcomes.filter(
    (outcome) =>
      !outcome.ok || outcome.findings.some((finding) => finding.status === "violation_persists"),
  );

  if (blockingFailures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
