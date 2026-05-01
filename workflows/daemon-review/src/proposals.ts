import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonOutcome } from "./types";

export type PrFileInfo = {
  filename: string;
  status: string;
  ranges: Array<{ start: number; end: number }>;
};

export type InlineComment = {
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

export type DaemonClassified = {
  daemonName: string;
  inlineComments: InlineComment[];
  fixupHunks: number;
  fixupFiles: string[];
  fixupPatchSegments: string[];
};

type FixupSummaryEntry = { daemonName: string; files: string[] };

export type FixupResult = {
  branchName: string;
  branchUrl: string;
  stackedPrUrl: string | null;
  stackedPrError: string | null;
  applied: FixupSummaryEntry[];
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

export function parsePrFilePatchRanges(patch: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of patch.split("\n")) {
    const header = parseHunkHeader(line);
    if (!header) continue;
    if (header.newCount === 0) continue;
    ranges.push({ start: header.newStart, end: header.newStart + header.newCount - 1 });
  }
  return ranges;
}

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

export function classifyDaemonDiff(
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

export async function pushFixupBranch(
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

export function buildReviewBody(
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

export function blockingOutcomes(outcomes: DaemonOutcome[]): DaemonOutcome[] {
  return outcomes.filter(
    (outcome) =>
      !outcome.ok || outcome.findings.some((finding) => finding.status === "violation_persists"),
  );
}
