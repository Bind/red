#!/usr/bin/env bun

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  loadMemorySnapshot,
  resolveDaemon,
  runDaemon,
  type CompleteFinding,
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
  proposal?: {
    files: string[];
    patch: string;
  };
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
  if (outcome.proposal) {
    lines.push(`- proposal: ${outcome.proposal.files.length} file(s) would be changed`);
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

async function runCommand(
  cwd: string,
  cmd: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return { ok: true, stdout };
  return { ok: false, stdout, stderr };
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
    lines.push("- Proposal mode is active: do not rely on mutating the real checkout.");
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

async function initProposalRepo(workingRoot: string): Promise<void> {
  await runCommand(workingRoot, ["git", "init", "-q"]);
  await runCommand(workingRoot, ["git", "add", "-A"]);
  await runCommand(workingRoot, [
    "git",
    "-c",
    "user.email=daemon@local",
    "-c",
    "user.name=daemon",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "baseline",
  ]);
}

async function buildProposalPatch(workingRoot: string): Promise<string> {
  await runCommand(workingRoot, ["git", "add", "-A"]);
  const diff = await runCommand(workingRoot, ["git", "diff", "HEAD"]);
  if (diff.ok) return diff.stdout;
  return "";
}

function extractPatchedFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match?.[2]) files.add(match[2]);
  }
  return [...files];
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
    await initProposalRepo(workingRoot);
  }

  console.log(`running daemon ${daemonName} against ${workingRoot}`);
  const result = await runDaemon(daemonName, {
    root: workingRoot,
    input: reviewInput,
    maxTurns: config.maxTurns,
    maxWallclockMs: 180_000,
  });

  const proposalPatch =
    proposalMode && result.ok
      ? await buildProposalPatch(workingRoot)
      : "";
  const proposalFiles = proposalPatch ? extractPatchedFiles(proposalPatch) : [];
  const proposal =
    proposalPatch && proposalFiles.length > 0
      ? {
          files: proposalFiles,
          patch: proposalPatch,
        }
      : undefined;

  if (proposalMode) {
    await rm(workingRoot, { recursive: true, force: true });
  }

  if (result.ok === false) {
    return {
      name: daemonName,
      ok: false,
      summary: "",
      findings: [],
      reason: result.reason,
      message: result.message,
    };
  }

  return {
    name: daemonName,
    ok: true,
    summary: result.payload.summary,
    findings: result.payload.findings,
    proposal,
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

type ProposalHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  newLines: string[];
};

type ParsedProposalFile = {
  path: string;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hunks: ProposalHunk[];
};

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

function parseProposalPatch(patch: string): ParsedProposalFile[] {
  const files: ParsedProposalFile[] = [];
  const lines = patch.split("\n");
  let current: ParsedProposalFile | null = null;
  let currentHunk: ProposalHunk | null = null;

  const flushHunk = () => {
    if (current && currentHunk) current.hunks.push(currentHunk);
    currentHunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = match?.[2] ?? "";
      current = { path, isNewFile: false, isDeletedFile: false, hunks: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.isNewFile = true;
    else if (line.startsWith("deleted file mode")) current.isDeletedFile = true;
    else if (line.startsWith("@@")) {
      flushHunk();
      const header = parseHunkHeader(line);
      if (header) currentHunk = { ...header, newLines: [] };
    } else if (currentHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentHunk.newLines.push(line.slice(1));
      }
    }
  }
  flushFile();
  return files;
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
  fallbackFiles: string[];
  fallbackPatch: string;
};

function rangeContains(
  outer: { start: number; end: number },
  inner: { start: number; end: number },
): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function buildInlineComment(
  daemonName: string,
  filePath: string,
  hunk: ProposalHunk,
): InlineComment {
  const oldEnd = hunk.oldStart + Math.max(hunk.oldCount, 1) - 1;
  const body = [
    `Daemon \`${daemonName}\` suggests:`,
    "",
    "```suggestion",
    hunk.newLines.join("\n"),
    "```",
  ].join("\n");
  const comment: InlineComment = {
    path: filePath,
    line: oldEnd,
    side: "RIGHT",
    body,
  };
  if (hunk.oldCount > 1) {
    comment.start_line = hunk.oldStart;
    comment.start_side = "RIGHT";
  }
  return comment;
}

function classifyProposalForInline(
  daemonName: string,
  patch: string,
  prFiles: Map<string, PrFileInfo>,
): ClassifiedProposal {
  const parsed = parseProposalPatch(patch);
  const inlineComments: InlineComment[] = [];
  const fallbackPieces: string[] = [];
  const fallbackFiles = new Set<string>();

  for (const file of parsed) {
    const prInfo = prFiles.get(file.path);
    const fileEligible =
      !file.isNewFile && !file.isDeletedFile && prInfo && prInfo.ranges.length > 0;
    for (const hunk of file.hunks) {
      const target = {
        start: hunk.oldStart,
        end: hunk.oldStart + Math.max(hunk.oldCount, 1) - 1,
      };
      const inlineable =
        fileEligible && hunk.oldCount > 0 && prInfo!.ranges.some((range) => rangeContains(range, target));
      if (inlineable) {
        inlineComments.push(buildInlineComment(daemonName, file.path, hunk));
      } else {
        fallbackFiles.add(file.path);
        fallbackPieces.push(
          [
            `--- ${file.path} hunk @ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}`,
            ...hunk.newLines.map((line) => `+${line}`),
          ].join("\n"),
        );
      }
    }
  }
  return {
    daemonName,
    inlineComments,
    fallbackFiles: [...fallbackFiles],
    fallbackPatch: fallbackPieces.join("\n\n"),
  };
}

async function postProposalReview(
  githubToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
  daemonName: string,
  comments: InlineComment[],
): Promise<void> {
  if (comments.length === 0) return;
  const body = `Daemon \`${daemonName}\` posted ${comments.length} healing suggestion${comments.length === 1 ? "" : "s"}.`;
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

async function upsertFallbackComment(
  githubToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
  classifications: ClassifiedProposal[],
): Promise<void> {
  const fallbacks = classifications.filter((c) => c.fallbackPatch.length > 0);
  if (fallbacks.length === 0) return;

  const marker = "<!-- daemon-review-proposals -->";
  const sections = fallbacks.map((c) => {
    const patch = c.fallbackPatch.length > 12_000
      ? `${c.fallbackPatch.slice(0, 12_000)}\n\n...diff truncated...`
      : c.fallbackPatch;
    return [
      `### ${c.daemonName}`,
      "",
      `Out-of-PR-diff edits in: ${c.fallbackFiles.join(", ")}`,
      "",
      "```diff",
      patch.trim(),
      "```",
    ].join("\n");
  });
  const body = [
    marker,
    "## Daemon Healing Suggestions (out-of-diff)",
    "",
    "Inline `suggestion` review comments were posted on lines that overlap the PR's diff. The proposals below touch lines outside the PR's diff, so GitHub can't render them as one-click suggestions.",
    "",
    ...sections,
  ].join("\n");

  const listResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=100`,
    {
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "redc-daemon-review",
      },
    },
  );
  if (!listResponse.ok) {
    throw new Error(`failed to list PR comments: ${listResponse.status} ${await listResponse.text()}`);
  }
  const comments = (await listResponse.json()) as Array<{ id: number; body?: string }>;
  const existing = comments.find((comment) => comment.body?.includes(marker));

  const targetUrl = existing
    ? `https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`
    : `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments`;
  const method = existing ? "PATCH" : "POST";
  const response = await fetch(targetUrl, {
    method,
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "redc-daemon-review",
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(`failed to upsert PR proposal comment: ${response.status} ${await response.text()}`);
  }
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

  const proposals = outcomes.filter((outcome) => outcome.ok && outcome.proposal);
  if (proposals.length > 0) {
    try {
      const prFiles = await fetchPrFiles(githubToken, owner, repo, prNumber);
      const classifications = proposals.map((outcome) =>
        classifyProposalForInline(outcome.name, outcome.proposal!.patch, prFiles),
      );
      for (const classification of classifications) {
        try {
          await postProposalReview(
            githubToken,
            owner,
            repo,
            prNumber,
            classification.daemonName,
            classification.inlineComments,
          );
        } catch (error) {
          console.error(
            `daemon review inline suggestions failed for ${classification.daemonName}:`,
            error,
          );
        }
      }
      await upsertFallbackComment(githubToken, owner, repo, prNumber, classifications);
    } catch (error) {
      console.error("daemon review proposal comment failed:", error);
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
