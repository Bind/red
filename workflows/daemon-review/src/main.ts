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

async function buildProposalPatch(baseRoot: string, proposalRoot: string): Promise<string> {
  const diff = await runCommand(process.cwd(), [
    "git",
    "diff",
    "--no-index",
    "--relative",
    "--",
    baseRoot,
    proposalRoot,
  ]);
  if (diff.ok) return diff.stdout;
  const failure = diff as { ok: false; stdout: string; stderr: string };
  const combined = `${failure.stdout}${failure.stderr}`;
  if (combined.includes("diff --git")) return combined;
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
      ? await buildProposalPatch(prRoot, workingRoot)
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

async function upsertProposalComment(
  githubToken: string,
  owner: string,
  repo: string,
  pullNumber: number,
  outcomes: DaemonOutcome[],
): Promise<void> {
  const proposed = outcomes.filter((outcome) => outcome.ok && outcome.proposal);
  if (proposed.length === 0) return;

  const marker = "<!-- daemon-review-proposals -->";
  const sections = proposed.map((outcome) => {
    const proposal = outcome.proposal!;
    const patch = proposal.patch.length > 12_000
      ? `${proposal.patch.slice(0, 12_000)}\n\n...diff truncated...`
      : proposal.patch;
    return [
      `### ${outcome.name}`,
      "",
      `Would update: ${proposal.files.join(", ")}`,
      "",
      "```diff",
      patch.trim(),
      "```",
    ].join("\n");
  });
  const body = [
    marker,
    "## Daemon Healing Suggestions",
    "",
    "These daemon runs were executed in proposal mode against a disposable copy of the PR checkout. No files were changed in CI.",
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

  try {
    await upsertProposalComment(githubToken, owner, repo, prNumber, outcomes);
  } catch (error) {
    console.error("daemon review proposal comment failed:", error);
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
