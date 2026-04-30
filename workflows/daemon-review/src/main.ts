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
  diff: string;
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
  "scripts/red",
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
    authorityPaths: ["README.md", "justfile", "scripts/red", "apps/ctl/cli/"],
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
          "user-agent": "red-daemon-review",
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
  if (outcome.diff.length > 0) {
    const filesTouched = new Set<string>();
    for (const line of outcome.diff.split("\n")) {
      const match = line.match(/^\+\+\+ b\/(.+)$/);
      if (match) filesTouched.add(match[1]);
    }
    lines.push(`- edits: ${filesTouched.size} file(s) touched`);
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
      "- Proposal mode is active: when you can confidently apply a heal, edit the file directly with `Edit` or `Write` in your working tree. Your edits are scanned post-run and turned into inline `suggestion` review comments (or a stacked fixup PR for changes outside the PR's diff hunks). The real checkout is not modified.",
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
    await gitOrThrow(workingRoot, ["init", "-q", "-b", "base"]);
    await gitOrThrow(workingRoot, ["add", "-A"]);
    await gitOrThrow(workingRoot, [
      "-c",
      "user.email=daemon-review@local",
      "-c",
      "user.name=daemon-review",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "baseline",
    ]);
  }

  console.log(`running daemon ${daemonName} against ${workingRoot}`);
  const result = await runDaemon(daemonName, {
    root: workingRoot,
    input: reviewInput,
    maxTurns: config.maxTurns,
    maxWallclockMs: 180_000,
  });

  let diff = "";
  if (proposalMode) {
    try {
      diff = await gitOrThrow(workingRoot, ["diff", "--no-color"]);
    } catch (error) {
      console.error(`failed to capture daemon diff for ${daemonName}:`, error);
    }
    await rm(workingRoot, { recursive: true, force: true });
  }

  if (result.ok === false) {
    return {
      name: daemonName,
      ok: false,
      summary: "",
      findings: [],
      diff: "",
      reason: result.reason,
      message: result.message,
    };
  }

  return {
    name: daemonName,
    ok: true,
    summary: result.payload.summary,
    findings: result.payload.findings,
    diff,
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

type InlineComment = {
  path: string;
  line: number;
  start_line?: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
};

type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  newText: string;
  raw: string;
};

type FileDiff = {
  oldPath: string | null;
  newPath: string | null;
  headerLines: string[];
  hunks: DiffHunk[];
};

type DaemonClassified = {
  daemonName: string;
  inlineComments: InlineComment[];
  fixupHunks: number;
  fixupFiles: string[];
  fixupPatchSegments: string[];
};

function rangeContains(
  outer: { start: number; end: number },
  inner: { start: number; end: number },
): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  if (patch.trim().length === 0) return files;
  const lines = patch.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i += 1;
      continue;
    }
    const headerLines: string[] = [lines[i]];
    let oldPath: string | null = null;
    let newPath: string | null = null;
    i += 1;
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
      headerLines.push(lines[i]);
      if (lines[i].startsWith("--- ")) {
        const value = lines[i].slice(4);
        oldPath = value === "/dev/null" ? null : value.replace(/^a\//, "");
      } else if (lines[i].startsWith("+++ ")) {
        const value = lines[i].slice(4);
        newPath = value === "/dev/null" ? null : value.replace(/^b\//, "");
      }
      i += 1;
    }
    const hunks: DiffHunk[] = [];
    while (i < lines.length && lines[i].startsWith("@@")) {
      const headerMatch = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!headerMatch) {
        i += 1;
        continue;
      }
      const oldStart = Number.parseInt(headerMatch[1], 10);
      const oldCount = headerMatch[2] !== undefined ? Number.parseInt(headerMatch[2], 10) : 1;
      const newStart = Number.parseInt(headerMatch[3], 10);
      const newCount = headerMatch[4] !== undefined ? Number.parseInt(headerMatch[4], 10) : 1;
      const headerLine = lines[i];
      i += 1;
      const bodyLines: string[] = [];
      const newSideLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
        const line = lines[i];
        if (line.startsWith("+")) {
          newSideLines.push(line.slice(1));
          bodyLines.push(line);
        } else if (line.startsWith("-")) {
          bodyLines.push(line);
        } else if (line.startsWith(" ")) {
          newSideLines.push(line.slice(1));
          bodyLines.push(line);
        } else if (line.startsWith("\\")) {
          bodyLines.push(line);
        } else if (line.length === 0 && i === lines.length - 1) {
          break;
        } else {
          break;
        }
        i += 1;
      }
      hunks.push({
        oldStart,
        oldCount,
        newStart,
        newCount,
        newText: newSideLines.join("\n"),
        raw: [headerLine, ...bodyLines].join("\n"),
      });
    }
    files.push({ oldPath, newPath, headerLines, hunks });
  }
  return files;
}

function buildInlineCommentFromHunk(
  daemonName: string,
  file: string,
  hunk: DiffHunk,
): InlineComment | null {
  if (hunk.oldCount === 0) return null;
  const body = [
    `Daemon \`${daemonName}\` suggests:`,
    "```suggestion",
    hunk.newText,
    "```",
  ].join("\n");
  const endLine = hunk.oldStart + hunk.oldCount - 1;
  const comment: InlineComment = {
    path: file,
    line: endLine,
    side: "RIGHT",
    body,
  };
  if (endLine > hunk.oldStart) {
    comment.start_line = hunk.oldStart;
    comment.start_side = "RIGHT";
  }
  return comment;
}

function classifyDaemonDiff(
  daemonName: string,
  diff: string,
  prFiles: Map<string, PrFileInfo>,
): DaemonClassified {
  const inlineComments: InlineComment[] = [];
  const fixupFiles = new Set<string>();
  const fixupPatchSegments: string[] = [];
  let fixupHunks = 0;
  for (const fileDiff of parseUnifiedDiff(diff)) {
    const file = fileDiff.newPath ?? fileDiff.oldPath;
    if (!file) continue;
    const prInfo = fileDiff.oldPath ? prFiles.get(fileDiff.oldPath) : undefined;
    const fileFixupHunks: DiffHunk[] = [];
    for (const hunk of fileDiff.hunks) {
      const inline =
        fileDiff.oldPath !== null &&
        prInfo !== undefined &&
        hunk.oldCount > 0 &&
        prInfo.ranges.some((range) =>
          rangeContains(range, { start: hunk.oldStart, end: hunk.oldStart + hunk.oldCount - 1 }),
        );
      if (inline) {
        const comment = buildInlineCommentFromHunk(daemonName, fileDiff.oldPath as string, hunk);
        if (comment) {
          inlineComments.push(comment);
          continue;
        }
      }
      fileFixupHunks.push(hunk);
    }
    if (fileFixupHunks.length > 0) {
      fixupHunks += fileFixupHunks.length;
      fixupFiles.add(file);
      const segment = [
        ...fileDiff.headerLines,
        ...fileFixupHunks.map((hunk) => hunk.raw),
      ].join("\n");
      fixupPatchSegments.push(`${segment}\n`);
    }
  }
  return {
    daemonName,
    inlineComments,
    fixupHunks,
    fixupFiles: [...fixupFiles].sort(),
    fixupPatchSegments,
  };
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

type FixupSummaryEntry = { daemonName: string; files: string[] };

type FixupResult = {
  branchName: string;
  branchUrl: string;
  stackedPrUrl: string | null;
  stackedPrError: string | null;
  applied: FixupSummaryEntry[];
};

async function ensureStackedPr(
  owner: string,
  repo: string,
  branchName: string,
  baseRef: string,
  prNumber: number,
  applied: FixupSummaryEntry[],
  githubToken: string,
): Promise<string> {
  const headers = {
    authorization: `Bearer ${githubToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "red-daemon-review",
  } as const;

  const listUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${branchName}&base=${encodeURIComponent(baseRef)}`;
  const listResponse = await fetch(listUrl, { headers });
  if (!listResponse.ok) {
    throw new Error(
      `failed to list stacked PRs for ${branchName}: ${listResponse.status} ${await listResponse.text()}`,
    );
  }
  const existingList = (await listResponse.json()) as Array<{ html_url: string }>;
  if (existingList.length > 0) {
    return existingList[0].html_url;
  }

  const bodyLines = [
    `Auto-generated by daemon-review for #${prNumber}.`,
    "",
    "Files touched:",
    ...applied.flatMap(({ daemonName, files }) =>
      files.map((file) => `- \`${daemonName}\`: \`${file}\``),
    ),
    "",
    `Merge this PR into \`${baseRef}\` to land the heals on top of #${prNumber}.`,
  ];

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
  if (!createResponse.ok) {
    throw new Error(
      `failed to create stacked PR ${branchName} → ${baseRef}: ${createResponse.status} ${await createResponse.text()}`,
    );
  }
  const created = (await createResponse.json()) as { html_url: string };
  return created.html_url;
}

async function pushFixupBranch(
  owner: string,
  repo: string,
  prNumber: number,
  prHeadSha: string,
  prHeadRef: string,
  classifications: DaemonClassified[],
  githubToken: string,
): Promise<FixupResult | null> {
  const contributing = classifications.filter((c) => c.fixupPatchSegments.length > 0);
  if (contributing.length === 0) return null;

  const branchName = `claude/daemon-fixup-pr-${prNumber}`;
  const fixupRoot = await mkdtemp(join(tmpdir(), `daemon-fixup-${prNumber}-`));
  const remoteUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;

  await gitOrThrow(fixupRoot, ["init", "-q"]);
  await gitOrThrow(fixupRoot, ["remote", "add", "origin", remoteUrl]);
  await gitOrThrow(fixupRoot, ["fetch", "--depth", "1", "origin", prHeadSha]);
  await gitOrThrow(fixupRoot, ["checkout", "-b", branchName, prHeadSha]);

  const applied: FixupSummaryEntry[] = [];
  for (const classification of contributing) {
    const patch = classification.fixupPatchSegments.join("");
    const patchPath = join(fixupRoot, `.daemon-fixup-${classification.daemonName}.patch`);
    await writeFile(patchPath, patch);
    const result = await runGit(fixupRoot, ["apply", "--whitespace=nowarn", patchPath]);
    await rm(patchPath, { force: true });
    if (!result.ok) {
      console.error(
        `git apply failed for ${classification.daemonName}: ${result.stderr || result.stdout}`,
      );
      continue;
    }
    applied.push({ daemonName: classification.daemonName, files: classification.fixupFiles });
  }

  if (applied.length === 0) {
    await rm(fixupRoot, { recursive: true, force: true });
    return null;
  }

  const messageLines = [`Daemon fixup for PR #${prNumber}`, ""];
  for (const { daemonName, files } of applied) {
    for (const file of files) {
      messageLines.push(`- ${daemonName}: ${file}`);
    }
  }
  await gitOrThrow(fixupRoot, [
    "-c",
    "user.email=daemon-fixup@local",
    "-c",
    "user.name=daemon-fixup",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-am",
    messageLines.join("\n"),
  ]);
  await gitOrThrow(fixupRoot, ["push", "--force", "origin", branchName]);
  await rm(fixupRoot, { recursive: true, force: true });

  let stackedPrUrl: string | null = null;
  let stackedPrError: string | null = null;
  try {
    stackedPrUrl = await ensureStackedPr(
      owner,
      repo,
      branchName,
      prHeadRef,
      prNumber,
      applied,
      githubToken,
    );
  } catch (error) {
    stackedPrError = error instanceof Error ? error.message : String(error);
    console.error("failed to ensure stacked fixup PR:", error);
  }

  return {
    branchName,
    branchUrl: `https://github.com/${owner}/${repo}/tree/${branchName}`,
    stackedPrUrl,
    stackedPrError,
    applied,
  };
}

function buildReviewBody(
  classification: DaemonClassified,
  fixup: FixupResult | null,
): string {
  const lines: string[] = [];
  const inlineCount = classification.inlineComments.length;
  if (inlineCount > 0) {
    lines.push(
      `Daemon \`${classification.daemonName}\` posted ${inlineCount} inline healing suggestion${inlineCount === 1 ? "" : "s"}.`,
    );
  }
  const daemonContributedFixup =
    fixup !== null &&
    fixup.applied.some((entry) => entry.daemonName === classification.daemonName);
  if (daemonContributedFixup && fixup) {
    const target = fixup.stackedPrUrl
      ? `stacked PR ${fixup.stackedPrUrl}`
      : `branch [\`${fixup.branchName}\`](${fixup.branchUrl})`;
    lines.push(
      "",
      `${classification.fixupHunks} additional hunk${classification.fixupHunks === 1 ? "" : "s"} fall outside this PR's diff hunks and have been committed to ${target}:`,
      "",
      ...classification.fixupFiles.map((file) => `- \`${file}\``),
    );
    if (!fixup.stackedPrUrl && fixup.stackedPrError) {
      lines.push("", `_Stacked PR creation failed: ${fixup.stackedPrError}_`);
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

  const editingOutcomes = outcomes.filter(
    (outcome) => outcome.ok && outcome.diff.trim().length > 0,
  );
  if (editingOutcomes.length > 0) {
    try {
      const prFiles = await fetchPrFiles(githubToken, owner, repo, prNumber);
      const classifications = editingOutcomes.map((outcome) =>
        classifyDaemonDiff(outcome.name, outcome.diff, prFiles),
      );
      let fixup: FixupResult | null = null;
      try {
        fixup = await pushFixupBranch(
          owner,
          repo,
          prNumber,
          requiredEnv("PR_HEAD_SHA"),
          requiredEnv("PR_HEAD_REF"),
          classifications,
          githubToken,
        );
      } catch (error) {
        console.error("daemon fixup branch push failed:", error);
      }
      for (const classification of classifications) {
        const body = buildReviewBody(classification, fixup);
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
