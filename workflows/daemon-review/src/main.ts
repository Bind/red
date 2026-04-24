#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
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
};

const DOC_SURFACE_PATHS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "justfile",
  "scripts/redc",
  "docs/",
  ".agents/skills/",
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

function selectDaemons(changedFiles: string[]): string[] {
  const selected = new Set<string>();

  if (changedFiles.some((path) => matchesAnyPrefix(path, DOC_SURFACE_PATHS))) {
    selected.add("docs-command-surface");
  }

  if (changedFiles.some((path) => matchesAnyPrefix(path, INFRA_PATHS))) {
    selected.add("compose-contract");
    selected.add("environment-layering");
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

  const outcomes: DaemonOutcome[] = [];
  for (const daemonName of daemonNames) {
    console.log(`running daemon ${daemonName} against ${prRoot}`);
    const result = await runDaemon(daemonName, {
      root: prRoot,
      maxTurns: 24,
      maxWallclockMs: 180_000,
    });

    if (!result.ok) {
      outcomes.push({
        name: daemonName,
        ok: false,
        summary: "",
        findings: [],
        reason: result.reason,
        message: result.message,
      });
      continue;
    }

    outcomes.push({
      name: daemonName,
      ok: true,
      summary: result.payload.summary,
      findings: result.payload.findings,
    });
  }

  const summaryLines = [
    "# Daemon Review",
    "",
    `PR: #${prNumber}`,
    `Changed files: ${changedFiles.length}`,
    `Daemons: ${daemonNames.join(", ")}`,
    "",
    ...outcomes.map(renderOutcome),
    "",
  ];

  const summary = summaryLines.join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
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
